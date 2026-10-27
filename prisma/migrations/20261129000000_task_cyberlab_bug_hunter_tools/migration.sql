-- Bug hunter tool catalog seed rows (PLAN_CYBERLAB_AGENT_RUNTIME.md P1)
-- Additive only: inserts rows into the existing LabToolCatalog table.
-- Every row carries ATT&CK technique ids, licence, legalBasis, and a staleAfter
-- date so the research gate can mark them "refresh required" when they age out.

-- Offensive: web content discovery / directory busting
INSERT INTO "LabToolCatalog" (slug, name, klass, kind, "techniqueIds", "upstreamVersion", "upstreamReleasedAt", "lastReviewedAt", "staleAfter", "cveHistory", licence, derivation, audience, "legalBasis", enabled, "createdAt", "updatedAt")
VALUES
  ('ffuf', 'ffuf', 'network', 'offensive', '["T1595"]', '2.1.0', '2026-03-15'::timestamptz, '2026-10-02'::timestamptz, '2027-10-02'::timestamptz, '[]'::json, 'MIT', 'Web fuzzer used in real-world bug bounty recon', 'staff', 'Owner-authorized web content discovery against attested targets only.', true, now(), now()),

  ('hydra', 'Hydra', 'network', 'offensive', '["T1110.001"]', '9.5', '2026-01-10'::timestamptz, '2026-10-02'::timestamptz, '2027-10-02'::timestamptz, '[]'::json, 'AGPL-3.0', 'Password spraying tool observed in APT campaigns', 'staff', 'Credential testing only against attested services the user owns.', true, now(), now()),

  ('burp-suite-community', 'Burp Suite Community', 'network', 'offensive', '["T1190"]', 'Community 2026.4', '2026-06-01'::timestamptz, '2026-10-02'::timestamptz, '2027-10-02'::timestamptz, '[]'::json, 'Proprietary (free Community tier)', 'Web app proxy used in bug bounty programs', 'staff', 'Manual and automated web app testing on attested targets only.', true, now(), now()),

  ('nuclei', 'nuclei', 'network', 'offensive', '["T1595"]', '3.3.0', '2026-08-20'::timestamptz, '2026-10-02'::timestamptz, '2027-10-02'::timestamptz, '[]'::json, 'MIT', 'Template-based vulnerability scanner', 'staff', 'Vulnerability scanning against attested targets only.', true, now(), now()),

  ('nmap', 'nmap', 'network', 'offensive', '["T1046"]', '7.95', '2026-05-10'::timestamptz, '2026-10-02'::timestamptz, '2027-10-02'::timestamptz, '[]'::json, 'GPL-2.0', 'Network mapper, industry-standard service discovery', 'staff', 'Network service discovery on attested targets only.', true, now(), now()),

-- Offensive: DNS enumeration / tunneling
  ('dnsrecon', 'dnsrecon', 'dns', 'offensive', '["T1590.002"]', '0.10.1', '2026-04-01'::timestamptz, '2026-10-02'::timestamptz, '2027-10-02'::timestamptz, '[]'::json, 'GPL-2.0', 'DNS enumeration tool used in real-world recon', 'staff', 'DNS enumeration against attested domains the user owns.', true, now(), now()),

  ('dnscat2', 'dnscat2', 'dns', 'offensive', '["T1071.004"]', '0.07', '2026-02-15'::timestamptz, '2026-10-02'::timestamptz, '2027-10-02'::timestamptz, '[]'::json, 'GPL-2.0', 'DNS tunneling C2 observed in intrusion sets', 'staff', 'DNS tunneling proof-of-concept on attested targets only.', true, now(), now()),

-- Offensive: email / phishing simulation
  ('gophish', 'GoPhish', 'email', 'offensive', '["T1566.002"]', '0.12.0', '2026-07-01'::timestamptz, '2026-10-02'::timestamptz, '2027-10-02'::timestamptz, '[]'::json, 'MIT', 'Phishing simulation platform', 'staff', 'Phishing simulation only on attested targets with explicit consent.', true, now(), now()),

  ('swaks', 'swaks', 'email', 'offensive', '["T1566"]', '20230919.0', '2023-09-19'::timestamptz, '2026-10-02'::timestamptz, '2027-10-02'::timestamptz, '[]'::json, 'GPL-2.0', 'SMTP test tool used in real-world testing', 'staff', 'SMTP testing against attested mail servers the user owns.', true, now(), now()),

-- Offensive: adversary emulation
  ('mitre-caldera', 'MITRE Caldera', 'network', 'offensive', '["T1059"]', '4.2.0', '2026-09-01'::timestamptz, '2026-10-02'::timestamptz, '2027-10-02'::timestamptz, '[]'::json, 'Apache-2.0', 'Adversary emulation framework', 'staff', 'Adversary emulation on attested targets only.', true, now(), now()),

-- Defensive: vulnerability assessment
  ('nessus-essentials', 'Nessus Essentials', 'network', 'defensive', '["T1595.002"]', 'Essentials 10.x', '2026-01-01'::timestamptz, '2026-10-02'::timestamptz, '2027-10-02'::timestamptz, '[]'::json, 'Proprietary (free Essentials tier, non-commercial)', 'Vulnerability scanner used by defenders', 'staff', 'Defensive vulnerability assessment on attested targets only.', true, now(), now()),

-- Defensive: network analysis
  ('wireshark', 'Wireshark', 'network', 'defensive', '["T1040"]', '4.4.0', '2026-08-01'::timestamptz, '2026-10-02'::timestamptz, '2027-10-02'::timestamptz, '[]'::json, 'GPL-2.0', 'Packet capture and analysis', 'staff', 'Defensive packet capture on attested networks only.', true, now(), now());

-- Index hint: the research gate (lib/lab/tools.ts) reads `enabled` + `staleAfter`
-- to compute the visible set. Stale rows (staleAfter < now) are hidden automatically.