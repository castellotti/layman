import { describe, it, expect } from 'vitest';
import { redactString, filterPii } from './filter.js';

describe('redactString', () => {
  describe('email addresses', () => {
    it('redacts simple email', () => {
      expect(redactString('contact john@example.com please')).toBe('contact [REDACTED] please');
    });
    it('redacts email with subdomains', () => {
      expect(redactString('user@mail.corp.example.co.uk')).toBe('[REDACTED]');
    });
  });

  describe('IP addresses', () => {
    it('redacts IPv4', () => {
      expect(redactString('server at 10.42.3.100 is down')).toBe('server at [REDACTED] is down');
    });
    it('preserves localhost 127.0.0.1', () => {
      expect(redactString('bind to 127.0.0.1:8080')).toContain('127.0.0.1');
    });
    it('preserves 0.0.0.0', () => {
      expect(redactString('listening on 0.0.0.0')).toContain('0.0.0.0');
    });
    it('redacts full IPv6', () => {
      const ipv6 = '2001:0db8:85a3:0000:0000:8a2e:0370:7334';
      expect(redactString(`addr ${ipv6}`)).toBe('addr [REDACTED]');
    });
  });

  describe('MAC addresses', () => {
    it('redacts colon-separated MAC', () => {
      expect(redactString('mac 00:1A:2B:3C:4D:5E')).toBe('mac [REDACTED]');
    });
    it('redacts dash-separated MAC', () => {
      expect(redactString('mac 00-1A-2B-3C-4D-5E')).toBe('mac [REDACTED]');
    });
  });

  describe('SSN', () => {
    it('redacts US SSN format', () => {
      expect(redactString('ssn: 123-45-6789')).toBe('ssn: [REDACTED]');
    });
  });

  describe('credit card numbers', () => {
    it('redacts 16-digit card with spaces', () => {
      expect(redactString('card: 4111 1111 1111 1111')).toBe('card: [REDACTED]');
    });
    it('redacts 16-digit card with dashes', () => {
      expect(redactString('card: 4111-1111-1111-1111')).toBe('card: [REDACTED]');
    });
  });

  describe('IBAN', () => {
    it('redacts IBAN', () => {
      expect(redactString('account DE89370400440532013000')).toBe('account [REDACTED]');
    });
  });

  describe('phone numbers', () => {
    it('redacts international phone', () => {
      expect(redactString('call +1-555-123-4567')).toBe('call [REDACTED]');
    });
    it('redacts phone with parentheses', () => {
      expect(redactString('phone (555) 123-4567')).toBe('phone [REDACTED]');
    });
  });

  describe('secrets and tokens', () => {
    it('redacts JWT token', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
      expect(redactString(`token: ${jwt}`)).toBe('token: [REDACTED]');
    });

    it('redacts API key assignment', () => {
      expect(redactString('api_key=sk-abc123def456ghi789jkl012')).toBe('[REDACTED]');
    });

    it('redacts password assignment', () => {
      expect(redactString('password=MyS3cretP@ss!')).toBe('[REDACTED]');
    });

    it('redacts private key block', () => {
      const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBog...\n-----END RSA PRIVATE KEY-----';
      expect(redactString(pem)).toBe('[REDACTED]');
    });
  });

  describe('no false positives for normal text', () => {
    it('preserves normal sentences', () => {
      const text = 'The file was read successfully from /tmp/foo.ts';
      expect(redactString(text)).toBe(text);
    });
    it('preserves short numbers', () => {
      const text = 'line 42 of file.ts';
      expect(redactString(text)).toBe(text);
    });
  });
});

describe('filterPii', () => {
  it('redacts toolInput values recursively', () => {
    const data = {
      toolName: 'Bash',
      toolInput: { command: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" https://api.example.com' },
    };
    const result = filterPii(data);
    expect(result.toolInput?.command).toContain('[REDACTED]');
    expect(result.toolName).toBe('Bash');
  });

  it('redacts prompt field', () => {
    const data = { prompt: 'Send email to john@example.com' };
    const result = filterPii(data);
    expect(result.prompt).toBe('Send email to [REDACTED]');
  });

  it('redacts toolOutput strings', () => {
    const data = { toolOutput: 'User IP: 10.0.1.55, MAC: 00:1A:2B:3C:4D:5E' };
    const result = filterPii(data);
    expect(result.toolOutput).toBe('User IP: [REDACTED], MAC: [REDACTED]');
  });

  it('does not mutate original data', () => {
    const data = { prompt: 'email: john@example.com' };
    const result = filterPii(data);
    expect(data.prompt).toBe('email: john@example.com');
    expect(result.prompt).toBe('email: [REDACTED]');
  });

  it('handles undefined and null values', () => {
    const data = { toolName: undefined, toolInput: undefined };
    const result = filterPii(data);
    expect(result.toolName).toBeUndefined();
    expect(result.toolInput).toBeUndefined();
  });
});
