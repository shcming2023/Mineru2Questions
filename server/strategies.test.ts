import { describe, it, expect } from 'vitest';
import { StrategyChain, DEFAULT_TITLE_FILTERS, DEFAULT_ANSWER_DETECTION } from './strategies';

describe('QualityGate Strategy Chain (Chapter Titles)', () => {
  const chain = new StrategyChain(DEFAULT_TITLE_FILTERS);

  it('should drop section markers', () => {
    const result = chain.execute('section_marker_filter', { text: '一、选择题' });
    expect(result.action).toBe('drop');
    expect(result.score).toBe(1);
  });

  it('should keep valid titles', () => {
    const result = chain.execute('section_marker_filter', { text: '第1章 勾股定理' });
    expect(result.action).toBe('keep'); // Fallback to length_filter -> keep
  });

  it('should drop overly long titles via fallback', () => {
    const longText = 'A'.repeat(101);
    const result = chain.execute('section_marker_filter', { text: longText });
    expect(result.action).toBe('drop');
    expect(result.reason).toBe('Title too long');
  });
});

describe('CandidateBuilder Strategy Chain (Answer Detection)', () => {
  const chain = new StrategyChain(DEFAULT_ANSWER_DETECTION);

  it('should detect explicit answer headers', () => {
    const result = chain.execute('explicit_header_match', { text: '参考答案' });
    expect(result.action).toBe('found');
  });

  it('should reject long texts in short header fallback', () => {
    // Note: explicit_header_match will try pattern match FIRST. If it matches, it returns found.
    // If it doesn't match, it falls back to short_header_match.
    // short_header_match checks length.
    
    // Case 1: Long text that DOES NOT match pattern.
    const longText = 'This is a very long text that definitely does not look like an answer header and is longer than 20 chars';
    const result = chain.execute('explicit_header_match', { text: longText });
    // explicit -> no match -> fallback short -> length check fail -> keep
    expect(result.action).toBe('keep');
  });
  
  it('should detect short answer headers via fallback', () => {
     // If we call explicit_header_match with short text that matches pattern
     const result = chain.execute('explicit_header_match', { text: 'Answer Key' });
     expect(result.action).toBe('found');
  });

  it('should enforce length constraint when calling short_header_match directly', () => {
    const longTextWithPattern = 'This text contains Answer Key but is very long and should be rejected by short header strategy';
    const result = chain.execute('short_header_match', { text: longTextWithPattern });
    expect(result.action).toBe('keep');
    expect(result.reason).toBe('Text too long for heuristic');
  });
});
