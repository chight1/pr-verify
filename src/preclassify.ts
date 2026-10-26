/**
 * Rules-only triage for a red gate. Anything matched here is labelled before
 * the agent is considered, so the model never spends tokens on a flaky
 * network or a full disk.
 */

export type InfraLabel =
  | 'network'
  | 'registry'
  | 'out-of-memory'
  | 'disk'
  | 'cancelled'
  | 'timeout';

interface Rule {
  label: InfraLabel;
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    label: 'cancelled',
    patterns: [/The operation was canceled/i, /##\[error\]The run was canceled/i],
  },
  {
    label: 'timeout',
    patterns: [
      /has exceeded the maximum execution time/i,
      /The job running on runner .* has exceeded the maximum execution time/i,
    ],
  },
  {
    label: 'out-of-memory',
    patterns: [
      /JavaScript heap out of memory/i,
      /FATAL ERROR: .*Allocation failed/i,
      /\bOOMKilled\b/,
      /\bKilled\b.*process/i,
      /Cannot allocate memory/i,
      /java\.lang\.OutOfMemoryError/,
      /\bMemoryError\b/,
    ],
  },
  {
    label: 'disk',
    patterns: [/No space left on device/i, /\bENOSPC\b/, /disk quota exceeded/i],
  },
  {
    label: 'registry',
    patterns: [
      /npm (ERR!|error) code E(TIMEDOUT|CONNRESET|AI_AGAIN|SOCKETTIMEOUT|FETCH_ERROR|503|502|429)/,
      /npm (ERR!|error) network/i,
      /registry\.npmjs\.org.*(timed? ?out|ECONN|503|502)/i,
      /Could not fetch URL https:\/\/pypi\.org/i,
      /Read timed out\. \(read timeout=/i,
      /proxy\.golang\.org.*(timeout|503|502|dial tcp)/i,
      /Temporary failure in name resolution/i,
    ],
  },
  {
    label: 'network',
    patterns: [
      /\bETIMEDOUT\b/,
      /\bECONNRESET\b/,
      /\bECONNREFUSED\b/,
      /\bEAI_AGAIN\b/,
      /\bENOTFOUND\b/,
      /getaddrinfo .*failed/i,
      /Could not resolve host/i,
      /TLS handshake timeout/i,
      /curl: \(\d+\) .*(timed out|Could not resolve|Connection reset)/i,
      /Connection timed out/i,
    ],
  },
];

/** Gate steps the agent never investigates: it cannot run the scanner, so it could not verify a fix. */
export const SCAN_STEPS: Record<string, string> = {
  'security scan': 'Trivy found a vulnerability, secret or misconfiguration; the step log lists each one.',
  'install security scanner': 'The security scanner could not be downloaded or failed its checksum.',
};

export function scanFailure(stepName: string): string | null {
  return SCAN_STEPS[stepName.toLowerCase()] ?? null;
}

export interface PreclassifyResult {
  label: InfraLabel;
  /** The log line that matched, for the record and the comment. */
  evidence: string;
}

/**
 * Returns the infrastructure label for a failing log, or null when the
 * failure looks like it belongs to the code and deserves investigation.
 */
export function preclassify(log: string): PreclassifyResult | null {
  const lines = log.split('\n');
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const hit = lines.find((line) => pattern.test(line));
      if (hit !== undefined) {
        return { label: rule.label, evidence: hit.trim().slice(0, 300) };
      }
    }
  }
  return null;
}
