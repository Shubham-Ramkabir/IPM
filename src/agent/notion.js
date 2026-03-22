import { Client } from '@notionhq/client';

let _client = null;

export function initNotion(token) {
  _client = new Client({ auth: token });
}

// Fetch all pages/databases the integration has access to
export async function listDocs() {
  if (!_client) throw new Error('Notion not initialised');
  const results = [];
  let cursor;
  do {
    const res = await _client.search({
      filter: { value: 'page', property: 'object' },
      page_size: 50,
      start_cursor: cursor,
    });
    for (const page of res.results) {
      const title =
        page.properties?.title?.title?.[0]?.plain_text ||
        page.properties?.Name?.title?.[0]?.plain_text ||
        'Untitled';
      results.push({ id: page.id, title });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

// Recursively read all block content from a page
export async function readPage(pageId) {
  if (!_client) throw new Error('Notion not initialised');
  const lines = [];
  await readBlocks(pageId, lines, 0);
  return lines.join('\n');
}

async function readBlocks(blockId, lines, depth) {
  let cursor;
  do {
    const res = await _client.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const block of res.results) {
      const indent = '  '.repeat(depth);
      const text = extractText(block);
      if (text) lines.push(indent + text);
      if (block.has_children) {
        await readBlocks(block.id, lines, depth + 1);
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
}

function extractText(block) {
  const type = block.type;
  const data = block[type];
  if (!data) return '';
  const rich = data.rich_text || data.text || [];
  const plain = rich.map(r => r.plain_text || '').join('');
  const prefixes = {
    heading_1: '# ', heading_2: '## ', heading_3: '### ',
    bulleted_list_item: '• ', numbered_list_item: '1. ',
    to_do: data.checked ? '[x] ' : '[ ] ',
    code: '```\n' + plain + '\n```',
    quote: '> ',
    callout: '💡 ',
  };
  if (type === 'code') return prefixes.code;
  return (prefixes[type] || '') + plain;
}
