// popup.js — UI trigger for the clone operation. Talks to the native
// messaging host (com.spaceworker.clone) which runs the RMM-agent bridge.
//
// The extension is the ONLY visible UI on the work PC; everything below it
// (native host, CLI, tunnel) is silent plumbing by design (directive
// "Non-Negotiable UX Constraint").

const HOST_NAME = 'com.spaceworker.clone';

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
  // Query the spaceworker web app API.
  const response = await fetch('https://spaceworker.yourcompany.com/api/current-session');
  const data = await response.json();
  return data.hosted_pc_id;
}