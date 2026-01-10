import { describe, it, expect } from 'vitest';
const { sanitizeFilename } = require('../background.js');

describe('Utility Functions', () => {
  describe('sanitizeFilename', () => {
    it('should replace special characters with underscores', () => {
      expect(sanitizeFilename('Hello World!')).toBe('Hello_World_.pdf');
      expect(sanitizeFilename('PDF: Test (2024)')).toBe('PDF__Test__2024_.pdf');
    });

    it('should truncate long titles', () => {
      const longTitle = 'A'.repeat(100);
      const result = sanitizeFilename(longTitle);
      expect(result.length).toBe(54); // 50 chars + .pdf
      expect(result).toBe('A'.repeat(50) + '.pdf');
    });

    it('should handle empty titles with fallback', () => {
      expect(sanitizeFilename('')).toBe('page.pdf');
    });

    it('should handle titles with only special characters with fallback', () => {
      expect(sanitizeFilename('!!!@@@')).toBe('page.pdf');
    });

    it('should keep valid characters even with special chars mixed in', () => {
      expect(sanitizeFilename('Hello!')).toBe('Hello_.pdf');
    });
  });
});
