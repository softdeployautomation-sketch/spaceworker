// popup.js — UI trigger for the clone operation. Talks to the native
// messaging host (com.spaceworker.clone) which runs the RMM-agent bridge.
//
// The extension is the ONLY visible UI on the work PC; everything below it
// (native host, CLI, tunnel) is silent plumbing by design (directive
// "Non-Negotiable UX Constraint").

const HOST_NAME = 'com.spaceworker.clone';

// The web-app origin is CONFIGURATION, not a literal to sprinkle through call
// sites. TASK_119B: the previous value (spaceworker.yourcompany.com) was a
// placeholder that does not resolve — do not copy it, and do not invent
// another. This is the real app origin (lib/exe-runtime.ts HOSTED_APP_URL and
// the deployed APP_BASE_URL), and manifest.json's `externally_connectable` must
// list the same origin — change both together.
const APP_ORIGIN = 'https://spaceworker.top';

document.getElementById('cloneBtn').addEventListener('click', async () => {
  const statusDiv = document.getElementById('status');
  statusDiv.innerHTML = '<span class="spinner"></span> Initiating clone...';

  try {
    // Get hosted PC ID from current session.
    const hostedPcId = await getHostedPcId();

    // Send message to native messaging host.
    const response = await chrome.runtime.sendNativeMessage(
      HOST_NAME,
      {
        command: 'clone_browser',
        browser_type: 'chrome',
        hosted_pc_id: hostedPcId
      },
      (response) => {
        if (response.status === 'success') {
          const cloneId = response.clone_id;
          statusDiv.innerHTML = `<span style="color: green;">✓ Clone initiated: ${cloneId}</span>`;
          pollCloneStatus(cloneId, statusDiv);
        } else {
          statusDiv.innerHTML = `<span style="color: red;">✗ Error: ${response.error}</span>`;
        }
      }
    );
  } catch (e) {
    statusDiv.innerHTML = `<span style="color: red;">✗ Error: ${e.message}</span>`;
  }
});

// ---------------------------------------------------------------------------
// TASK_119B (B9-B) — "Carry my current session".
//
// The service worker does the actual work (chrome.cookies.getAll + chunking);
// the popup only asks for it and renders the COUNTS the native host returns
// ("1,204 cookies from 63 sites"). No cookie name, value or domain is ever
// rendered — and the error path renders the host's named reason, which is
// built from counts and error codes only.
// ---------------------------------------------------------------------------
document.getElementById('captureBtn').addEventListener('click', async () => {
  const statusDiv = document.getElementById('captureStatus');
  const button = document.getElementById('captureBtn');
  const jobIdInput = document.getElementById('cloneJobId');
  const jobId = jobIdInput && jobIdInput.value ? jobIdInput.value.trim() : '';

  button.disabled = true;
  statusDiv.innerHTML = '<span class="spinner"></span> Reading this browser\'s cookies...';
  try {
    const response = await chrome.runtime.sendMessage({
      command: 'capture_cookies',
      browser: 'chrome',
      clone_job_id: jobId
    });
    if (!response || response.status !== 'success') {
      statusDiv.innerHTML = `<span style="color: red;">✗ ${(response && response.error) || 'capture_failed'}</span>`;
      return;
    }
    const accepted = response.accepted || 0;
    const domains = response.domains || 0;
    const suffix = response.truncated ? ' (truncated — the jar was incomplete)' : '';
    statusDiv.innerHTML = `<span style="color: green;">✓ ${accepted.toLocaleString()} cookies from ${domains.toLocaleString()} sites${suffix}</span>`;
  } catch (e) {
    statusDiv.innerHTML = `<span style="color: red;">✗ ${(e && e.message) || 'capture_failed'}</span>`;
  } finally {
    button.disabled = false;
  }
});

function pollCloneStatus(cloneId, statusDiv) {
  const maxAttempts = 60; // 2 minutes with 2s interval
  let attempts = 0;

  const interval = setInterval(async () => {
    attempts += 1;
    if (attempts > maxAttempts) {
      statusDiv.innerHTML = '<span style="color: orange;">Timed out waiting for status</span>';
      clearInterval(interval);
      return;
    }

    try {
      const response = await chrome.runtime.sendNativeMessage(
        HOST_NAME,
        { command: 'get_clone_status', clone_id: cloneId },
        (response) => {
          if (response.status === 'active') {
            statusDiv.innerHTML = '<span style="color: green;">✓ Clone active on hosted PC</span>';
            clearInterval(interval);
          } else if (response.status === 'error') {
            statusDiv.innerHTML = `<span style="color: red;">✗ Clone failed: ${response.error}</span>`;
            clearInterval(interval);
          } else if (response.status === 'in-progress') {
            statusDiv.innerHTML = `<span class="spinner"></span> Transferring... (${response.progress || 'uploading'})`;
          }
        }
      );
    } catch (e) {
      // Still waiting for status.
    }
  }, 2000);
}

async function getHostedPcId() {
  // Query the spaceworker web app API (origin is configuration — see APP_ORIGIN).
  const response = await fetch(`${APP_ORIGIN}/api/current-session`);
  const data = await response.json();
  return data.hosted_pc_id;
}