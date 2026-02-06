import fs from 'node:fs';
import axios from 'axios';

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

// 分块函数
function chunkContentBlocks(blocks, maxChunkLen = 100000, overlapBlocks = 15) {
  const chunks = [];
  let currentChunk = [];
  let currentLen = 0;
  
  for (let i = 0; i < blocks.length; i++) {
    const blockJson = JSON.stringify(blocks[i]);
    const blockLen = blockJson.length + 2; // 加上逗号和空格
    
    if (currentLen + blockLen > maxChunkLen && currentChunk.length > 0) {
      chunks.push([...currentChunk]);
      
      // 保留overlap
      const overlapStart = Math.max(0, currentChunk.length - overlapBlocks);
      currentChunk = currentChunk.slice(overlapStart);
      currentLen = JSON.stringify(currentChunk).length;
    }
    
    currentChunk.push(blocks[i]);
    currentLen += blockLen;
  }
  
  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }
  
  return chunks;
}

const contentList = JSON.parse(fs.readFileSync('server/uploads/tasks/202602061350-1770357017038/content_list.json', 'utf-8'));
const converted = convertMinerUContentList(contentList);
const chunks = chunkContentBlocks(converted);

console.log(`转换后块数: ${converted.length}`);
console.log(`分块数: ${chunks.length}`);
for (let i = 0; i < chunks.length; i++) {
  const chunkJson = JSON.stringify(chunks[i], null, 2);
  console.log(`Chunk ${i+1}: ${chunks[i].length} 块, ${chunkJson.length} 字符, ID范围 ${chunks[i][0].id}-${chunks[i][chunks[i].length-1].id}`);
}

// 只打印第一个chunk的前几个块
console.log('\n第一个Chunk的前10个块:');
for (let i = 0; i < 10 && i < chunks[0].length; i++) {
  const b = chunks[0][i];
  console.log(`ID ${b.id}: ${b.type} - ${(b.text || '').substring(0, 50)}...`);
}
