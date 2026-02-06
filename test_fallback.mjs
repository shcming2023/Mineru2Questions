import fs from 'node:fs';

// 简化版的convertMinerUContentList
function convertMinerUContentList(contentList) {
  const convertedBlocks = [];
  let currentId = 0;
  
  const noisyTypes = new Set(['header', 'footer', 'page_number', 'aside_text']);

  for (const item of contentList) {
    if (noisyTypes.has(item.type)) {
      continue;
    }
    
    if (item.type === 'list' && item.sub_type === 'text' && item.list_items) {
      for (const listItem of item.list_items) {
        convertedBlocks.push({
          id: currentId,
          type: 'text',
          text: listItem
        });
        currentId++;
      }
      continue;
    }

    const block = {
      id: currentId,
      type: item.type
    };

    if (item.text) {
      block.text = item.text;
    }
    if (item.img_path) {
      block.img_path = item.img_path;
    }
    if (item.image_caption && item.image_caption.length > 0) {
      block.image_caption = item.image_caption.join(' ');
    }

    convertedBlocks.push(block);
    currentId++;
  }

  return convertedBlocks;
}

function convertCircledNumbers(label) {
  const circledMap = { '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5', '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9', '⑩': '10' };
  return circledMap[label] || label;
}

// 简化版的splitMultiQuestionFallback
function splitMultiQuestionFallback(blocks, chunkIndex = 0) {
  const results = [];
  
  // 题号模式
  const questionPatterns = [
    /^([①-⑳])\s*([\s\S]+)/,  // 圆圈数字
    /^(\d+)[\.\u3001]\s*([\s\S]+)/,   // 数字+点/顿号
    /^([一二三四五六七八九十]+)[\.\u3001、]\s*([\s\S]+)/,  // 中文数字
  ];
  
  // 章节标题模式
  const chapterPattern = /^第(\d+)章|^第(\d+)节|^(\d+\.\d+)\s/;
  
  let currentChapter = '';
  let currentQuestion = null;
  
  for (const block of blocks) {
    if (!block.text) continue;
    
    const text = block.text.trim();
    
    // 检查是否是章节标题
    const chapterMatch = text.match(chapterPattern);
    if (chapterMatch) {
      currentChapter = text.split('\n')[0].trim().substring(0, 30);
    }
    
    let matched = false;
    
    for (const pattern of questionPatterns) {
      const match = text.match(pattern);
      if (match) {
        // 保存上一个题目
        if (currentQuestion && currentQuestion.text.length > 10) {
          results.push({
            label: currentQuestion.label,
            question: currentQuestion.text,
            chapter_title: currentQuestion.chapter || '',
          });
        }
        
        // 开始新题目
        const labelRaw = match[1];
        const labelNum = convertCircledNumbers(labelRaw);
        currentQuestion = {
          label: labelNum,
          text: match[2] || '',
          chapter: currentChapter
        };
        matched = true;
        break;
      }
    }
    
    // 如果没有匹配到新题号,追加到当前题目
    if (!matched && currentQuestion) {
      currentQuestion.text += '\n' + text;
    }
  }
  
  // 保存最后一个题目
  if (currentQuestion && currentQuestion.text.length > 10) {
    results.push({
      label: currentQuestion.label,
      question: currentQuestion.text,
      chapter_title: currentQuestion.chapter || '',
    });
  }
  
  return results;
}

const contentList = JSON.parse(fs.readFileSync('server/uploads/tasks/202602061350-1770357017038/content_list.json', 'utf-8'));
const converted = convertMinerUContentList(contentList);

console.log(`转换后块数: ${converted.length}`);

// 测试fallback
const fallbackResults = splitMultiQuestionFallback(converted, 0);
console.log(`\nFallback提取结果: ${fallbackResults.length} 个题目`);

// 打印前5个题目
for (let i = 0; i < 5 && i < fallbackResults.length; i++) {
  const q = fallbackResults[i];
  console.log(`\n题目 ${i+1}:`);
  console.log(`  题号: ${q.label}`);
  console.log(`  章节: ${q.chapter_title}`);
  console.log(`  内容: ${q.question.substring(0, 100)}...`);
}
