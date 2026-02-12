
import { QuestionParser, ExtractedQuestion } from '../server/parser';
import { cleanChapterTitles } from '../server/extraction';
import { ConvertedBlock } from '../server/types';

// Mock data for QuestionParser
const mockBlocks: ConvertedBlock[] = [
  { id: 1, type: 'text', text: 'Line 1' },
  { id: 2, type: 'image', img_path: 'img1.jpg', image_caption: 'Figure 1' },
  { id: 3, type: 'text', text: 'Line 2' }
];

const parser = new QuestionParser(mockBlocks, '/images');

// Test 1: Image Embedding and Newline Joining
console.log('--- Test 1: Image Embedding and Newline Joining ---');

// We need to simulate how parseWithFallback calls getTextAndImagesFromIds
// We can do this by constructing an LLM output that references these IDs
const llmOutput = `
<chapter><title>1</title>
<qa_pair>
<label>1</label>
<type>exercise</type>
<question>1,2,3</question>
<solution>3</solution>
</qa_pair>
</chapter>
`;

// Note: parseWithFallback requires chunkIndex
const extracted = parser.parseWithFallback(llmOutput, 0);

if (extracted.length === 0) {
    console.error('❌ FAIL: No questions extracted.');
} else {
    const q = extracted[0];
    const expectedText = 'Line 1\n![Figure 1](/images/img1.jpg)\nLine 2';
    
    console.log('Question Text:', JSON.stringify(q.question));
    
    if (q.question === expectedText) {
      console.log('✅ PASS: Image embedded and newlines used.');
    } else {
      console.error('❌ FAIL: Question text mismatch.');
      console.error('Expected:', JSON.stringify(expectedText));
      console.error('Actual:  ', JSON.stringify(q.question));
    }
}


// Test 2: Chapter Title Refinement and Continuity
console.log('\n--- Test 2: Chapter Title Refinement and Continuity ---');
const questions: ExtractedQuestion[] = [
  { label: '10', chapter_title: '第19章 平方根', type: 'exercise', question: '', solution: '', images: [], has_answer: false },
  { label: '11', chapter_title: '基础训练', type: 'exercise', question: '', solution: '', images: [], has_answer: false }, // Should revert to 19.2
  { label: '12', chapter_title: '基础训练', type: 'exercise', question: '', solution: '', images: [], has_answer: false }, // Should revert to 19.2
  { label: '1', chapter_title: '第20章', type: 'exercise', question: '', solution: '', images: [], has_answer: false },   // Should be 20
  { label: '2', chapter_title: '20.1', type: 'exercise', question: '', solution: '', images: [], has_answer: false }      // Should be 20.1
];

// Note: cleanChapterTitles modifies the array in place or returns a new one?
// In extraction.ts it returns `questions.map(...)` which creates a new array.
const cleaned = cleanChapterTitles(questions);

console.log('Q10 Title:', cleaned[0].chapter_title); 
console.log('Q11 Title:', cleaned[1].chapter_title); 
console.log('Q12 Title:', cleaned[2].chapter_title); 
console.log('Q1 Title:', cleaned[3].chapter_title);  
console.log('Q2 Title:', cleaned[4].chapter_title);

// Expected behavior based on my implementation:
// Q10: "第19章 平方根" -> "19" (extracted number)
// Q11: "基础训练" -> "19" (reverted because label 11 follows 10)
// Q12: "基础训练" -> "19" (reverted because label 12 follows 11)
// Q1: "第20章" -> "20"
// Q2: "20.1" -> "20.1"

if (cleaned[0].chapter_title === '19' && 
    cleaned[1].chapter_title === '19' && 
    cleaned[2].chapter_title === '19' &&
    cleaned[3].chapter_title === '20' &&
    cleaned[4].chapter_title === '20.1') {
  console.log('✅ PASS: Chapter titles refined and continuity enforced.');
} else {
  console.error('❌ FAIL: Chapter title mismatch.');
  cleaned.forEach((q, i) => console.log(`Q${questions[i].label}: ${q.chapter_title}`));
}
