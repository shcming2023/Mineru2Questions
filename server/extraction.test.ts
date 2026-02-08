
import { describe, it, expect } from 'vitest';
import {
  normalizeTitle,
  normalizeLabel,
  convertCircledNumbers,
  getLabelKey,
  cleanChapterTitle,
  isNoiseEntry,
  splitMergedQuestion,
  chunkContentBlocks,
  ConvertedBlock,
  ExtractedQAPair,
  MergedQAPair
} from './extraction';

describe('extraction.ts helper functions', () => {

  describe('normalizeTitle', () => {
    it('should normalize titles correctly with strictMatch=false', () => {
      expect(normalizeTitle('19.1 平方根', false)).toBe('19.1');
      expect(normalizeTitle('19.1(一) 算术平方根', false)).toBe('19.1');
      expect(normalizeTitle('第23章', false)).toBe('23');
      expect(normalizeTitle('二十四', false)).toBe('二十四');
    });

    it('should normalize titles correctly with strictMatch=true', () => {
      expect(normalizeTitle('19.1 平方根', true)).toBe('19.1平方根');
    });

    it('should handle special characters', () => {
        expect(normalizeTitle('  19.1  \n', false)).toBe('19.1');
    });
  });

  describe('normalizeLabel & convertCircledNumbers', () => {
    it('should convert circled numbers', () => {
      expect(convertCircledNumbers('①')).toBe('1');
      expect(convertCircledNumbers('⑩')).toBe('10');
      expect(convertCircledNumbers('⑳')).toBe('20');
      expect(convertCircledNumbers('例①')).toBe('例1');
    });

    it('should normalize labels to numbers', () => {
      expect(normalizeLabel('1')).toBe(1);
      expect(normalizeLabel('1.')).toBe(1);
      expect(normalizeLabel('例1')).toBe(1);
      expect(normalizeLabel('①')).toBe(1);
      expect(normalizeLabel('习题2.1')).toBe(2); // Extracts first number
    });

    it('should return null for invalid labels', () => {
      expect(normalizeLabel('abc')).toBe(null);
    });
  });

  describe('getLabelKey', () => {
    it('should generate correct label keys', () => {
      expect(getLabelKey('1')).toBe('1');
      expect(getLabelKey('例1')).toBe('1');
      expect(getLabelKey('习题1')).toBe('1');
      expect(getLabelKey('1.1')).toBe('1.1');
      expect(getLabelKey('①')).toBe('1');
    });
  });

  describe('cleanChapterTitle', () => {
    it('should remove section markers', () => {
      expect(cleanChapterTitle('名校考题精选')).toBe('');
      expect(cleanChapterTitle('本期导读')).toBe('');
      expect(cleanChapterTitle('一、选择题')).toBe('');
    });

    it('should keep valid titles', () => {
      expect(cleanChapterTitle('19.1 平方根')).toBe('19.1 平方根');
    });
  });

  describe('isNoiseEntry', () => {
    it('should identify noise entries', () => {
      const noise1: MergedQAPair = {
        label: 1,
        question_chapter_title: 'Chapter 1',
        answer_chapter_title: 'Chapter 1',
        question: 'ISBN 978-7-107-12345-6',
        answer: '',
        solution: '',
        images: []
      };
      expect(isNoiseEntry(noise1)).toBe(true);

      const noise2: MergedQAPair = {
        label: 1,
        question_chapter_title: 'Chapter 1',
        answer_chapter_title: 'Chapter 1',
        question: '目录',
        answer: '',
        solution: '',
        images: []
      };
      expect(isNoiseEntry(noise2)).toBe(true);

      const fragment: MergedQAPair = {
        label: 1,
        question_chapter_title: '',
        answer_chapter_title: '',
        question: 'Short text', // Short text without chapter title
        answer: '',
        solution: '',
        images: []
      };
      expect(isNoiseEntry(fragment)).toBe(true);
    });

    it('should keep valid entries', () => {
      const valid: MergedQAPair = {
        label: 1,
        question_chapter_title: 'Chapter 1',
        answer_chapter_title: 'Chapter 1',
        question: 'What is 1+1?',
        answer: '2',
        solution: '',
        images: []
      };
      expect(isNoiseEntry(valid)).toBe(false);
    });
  });

  describe('splitMergedQuestion', () => {
    it('should split merged questions', () => {
        const qa: ExtractedQAPair = {
            label: '1',
            question: '1. Question 1 is long enough now\n2. Question 2 is also long enough now',
            answer: '',
            solution: '',
            chapter_title: 'Chapter 1',
            images: []
        };
        const blocks: ConvertedBlock[] = []; // Mock blocks
        
        const result = splitMergedQuestion(qa, blocks, 'images');
        expect(result).toHaveLength(2);
        expect(result[0].question).toContain('Question 1');
        expect(result[1].question).toContain('Question 2');
        expect(result[1].label).toBe('2');
    });

    it('should not split if only one label', () => {
        const qa: ExtractedQAPair = {
            label: '1',
            question: '1. Question 1',
            answer: '',
            solution: '',
            chapter_title: 'Chapter 1',
            images: []
        };
        const blocks: ConvertedBlock[] = [];
        
        const result = splitMergedQuestion(qa, blocks, 'images');
        expect(result).toHaveLength(1);
    });
  });

  describe('chunkContentBlocks', () => {
      it('should chunk blocks correctly', () => {
          const blocks: ConvertedBlock[] = Array.from({ length: 100 }, (_, i) => ({
              id: i,
              type: 'text',
              text: `Block ${i}`
          }));

          const chunks = chunkContentBlocks(blocks, 500, 5);
          expect(chunks.length).toBeGreaterThan(1);
          
          // Check overlap
          const firstChunk = chunks[0];
          const secondChunk = chunks[1];
          // Simple check: second chunk should start before first chunk ends (in terms of block IDs) if there is overlap
          // But here we are checking if the last few blocks of chunk 0 are present in chunk 1
          
          // Actually, let's just check the logic in extraction.ts:
          // const overlapStart = Math.max(0, currentChunk.length - overlapBlocks);
          // currentChunk = currentChunk.slice(overlapStart);
          
          const lastIdOfFirstChunk = firstChunk[firstChunk.length - 1].id;
          const firstIdOfSecondChunk = secondChunk[0].id;
          
          expect(firstIdOfSecondChunk).toBeLessThan(lastIdOfFirstChunk);
      });
  });

});
