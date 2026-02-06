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

const contentList = JSON.parse(fs.readFileSync('server/uploads/tasks/202602061350-1770357017038/content_list.json', 'utf-8'));
const converted = convertMinerUContentList(contentList);

console.log(`原始块数: ${contentList.length}`);
console.log(`转换后块数: ${converted.length}`);
console.log(`\n前10个转换后的块:`);
for (let i = 0; i < 10 && i < converted.length; i++) {
  const b = converted[i];
  console.log(`ID ${b.id}: type=${b.type}, text=${(b.text || '').substring(0, 60)}...`);
}

// 计算JSON大小
const jsonStr = JSON.stringify(converted, null, 2);
console.log(`\n转换后JSON大小: ${jsonStr.length} 字符`);
console.log(`估计分块数: ${Math.ceil(jsonStr.length / 100000)}`);
