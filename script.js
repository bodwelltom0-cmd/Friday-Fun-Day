// script.js - fully dynamic Friday Fun Day board
// - No hard-coded topics or question datasets
// - Picks random Wikipedia categories each run, fetches members, and creates questions & images dynamically
// - Difficulty scaling: top row = easiest (longer/more notable pages), bottom row = hardest (shorter/less notable pages)

const CATEGORY_COUNT = 4;
const TILES_PER_CATEGORY = 3;
const WIKI_CATEGORY_FETCH = 30; // how many random categories to request as candidates
const WIKI_CATEGORY_PAGE_LIMIT = 500; // max number of pages to request for a category

// DOM refs
const boardEl = document.getElementById('board');
const newBoardBtn = document.getElementById('newBoard');
const shuffleBtn = document.getElementById('shuffle');
const modal = document.getElementById('modal');
const modalImage = document.getElementById('modalImage');
const modalQuestion = document.getElementById('modalQuestion');
const modalAnswer = document.getElementById('modalAnswer');
const showAnswerBtn = document.getElementById('showAnswer');
const closeModalBtn = document.getElementById('closeModal');

// Utility: fetch JSON with error handling
async function fetchJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn('fetchJson failed', url, e);
    return null;
  }
}

// 1) Get random categories from Wikipedia (namespace 14)
async function getRandomCategories(count) {
  // ask for more than count to allow skipping tiny categories
  const limit = Math.max(count * 3, WIKI_CATEGORY_FETCH);
  const endpoint = 'https://en.wikipedia.org/w/api.php';
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    list: 'random',
    rnnamespace: '14',
    rnlimit: String(limit)
  });
  const url = `${endpoint}?${params.toString()}`;
  const data = await fetchJson(url);
  if (!data || !data.query || !data.query.random) return [];
  // random items include titles like "Category:Something"
  const cats = data.query.random
    .map(r => r.title)
    .filter(t => t && t.toLowerCase().startsWith('category:'))
    .map(t => t.replace(/^Category:/i, '').trim());
  // dedupe while preserving order
  const seen = new Set();
  const dedup = [];
  for (const c of cats) {
    if (!seen.has(c)) { seen.add(c); dedup.push(c); }
    if (dedup.length >= count * 3) break;
  }
  return dedup;
}

// 2) For a category name, fetch its articles (namespace 0)
async function fetchCategoryPages(categoryName) {
  const endpoint = 'https://en.wikipedia.org/w/api.php';
  const cmParams = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    list: 'categorymembers',
    cmtitle: `Category:${categoryName}`,
    cmnamespace: '0',
    cmlimit: String(WIKI_CATEGORY_PAGE_LIMIT)
  });
  const cmUrl = `${endpoint}?${cmParams.toString()}`;
  const cmData = await fetchJson(cmUrl);
  if (!cmData || !cmData.query || !cmData.query.categorymembers) return null;
  const members = cmData.query.categorymembers;
  if (!members.length) return [];

  // collect pageids in chunks (API limits pageids per request)
  const pageIds = members.map(m => m.pageid);
  const batches = [];
  const CHUNK = 50;
  for (let i = 0; i < pageIds.length; i += CHUNK) batches.push(pageIds.slice(i, i + CHUNK));

  const pages = [];
  for (const batch of batches) {
    const pParams = new URLSearchParams({
      action: 'query',
      format: 'json',
      origin: '*',
      pageids: batch.join('|'),
      prop: 'pageimages|extracts|info',
      exintro: '1',
      explaintext: '1',
      pithumbsize: '640',
      inprop: 'url'
    });
    const pUrl = `${endpoint}?${pParams.toString()}`;
    const pData = await fetchJson(pUrl);
    if (!pData || !pData.query || !pData.query.pages) continue;
    const batchPages = Object.values(pData.query.pages).map(p => ({
      pageid: p.pageid,
      title: p.title,
      extract: p.extract || '',
      thumbnail: p.thumbnail ? p.thumbnail.source : null,
      length: p.length || 0,
      fullurl: p.fullurl || null
    }));
    pages.push(...batchPages);
  }

  // remove pages whose title is too similar to the category name (optional)
  const filtered = pages.filter(p => {
    const t = p.title.toLowerCase();
    const cat = categoryName.toLowerCase();
    // Exclude pages that are the category itself or clearly meta pages
    if (t.includes('(disambiguation)')) return false;
    return true;
  });

  return filtered;
}

// 3) Choose a page based on difficulty
function choosePageByDifficulty(pages, difficulty) {
  // difficulty: 0 = easy, 1 = medium, 2 = hard
  if (!pages || pages.length === 0) return null;
  // sort by page length descending (longer pages -> usually more notable / easier)
  const sorted = [...pages].sort((a, b) => (b.length || 0) - (a.length || 0));
  const len = sorted.length;
  const easyEnd = Math.max(1, Math.floor(len * 0.2));
  const midStart = easyEnd;
  const midEnd = Math.max(midStart + 1, Math.floor(len * 0.7));

  let pool = [];
  if (difficulty === 0) pool = sorted.slice(0, easyEnd);
  else if (difficulty === 1) pool = sorted.slice(midStart, midEnd);
  else pool = sorted.slice(midEnd);

  // If pool is empty (small category), broaden selection
  if (!pool || pool.length === 0) pool = sorted;
  // random pick from pool
  return pool[Math.floor(Math.random() * pool.length)];
}

function singularize(word) {
  if (!word) return word;
  if (word.endsWith('ies')) return word.replace(/ies$/, 'y');
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function buildQuestionFromPage(page, category, difficulty) {
  const catSing = singularize(category.split(':').pop() || category);
  // Use the first sentence of the extract as a clue when available; keep it generic
  const firstSentence = page.extract ? page.extract.split('. ')[0].trim() : '';
  let question = '';
  if (difficulty === 0) {
    // easiest: simple prompt or short hint
    question = firstSentence && firstSentence.length > 20
      ? `Hint: ${firstSentence}.` // short hint
      : `Name this ${catSing}.`;
  } else if (difficulty === 1) {
    // medium: slightly more cryptic hint
    question = firstSentence && firstSentence.length > 20
      ? `${firstSentence}. Which ${catSing} is this?`
      : `Which ${catSing} is shown here?`;
  } else {
    // hard: minimal hint, perhaps only a small fact if available
    question = firstSentence && firstSentence.length > 60
      ? `${firstSentence.split(',')[0]}.` // take a short fragment
      : `Identify this ${catSing}.`;
  }
  return question;
}

function makeTileFromPage(page, category, difficulty) {
  const image = page.thumbnail || `https://source.unsplash.com/featured/?${encodeURIComponent(category)}`;
  const question = buildQuestionFromPage(page, category, difficulty);
  const answer = page.title;
  return { image, question, answer };
}

function createTileElement(item, valueLabel) {
  const tile = document.createElement('button');
  tile.className = 'tile';
  tile.tabIndex = 0;
  tile.setAttribute('data-image', item.image);
  tile.setAttribute('data-question', item.question);
  tile.setAttribute('data-answer', item.answer);
  tile.innerHTML = `<span class="value">${valueLabel}</span>`;
  tile.addEventListener('click', () => openModal(item));
  return tile;
}

async function buildBoard() {
  boardEl.innerHTML = '';

  // show temporary loading
  const loading = document.createElement('div');
  loading.className = 'note';
  loading.textContent = 'Generating a fresh, fully-dynamic board from Wikipedia — please wait...';
  boardEl.appendChild(loading);

  // 1) get candidate random categories
  const candidateCats = await getRandomCategories(CATEGORY_COUNT);
  if (!candidateCats || candidateCats.length === 0) {
    loading.textContent = 'Failed to fetch categories from Wikipedia. Please check your network and try again.';
    return;
  }

  // pick the first CATEGORY_COUNT unique categories that have enough pages
  const chosen = [];
  const categoryPagesMap = {};

  for (const cat of candidateCats) {
    if (chosen.length >= CATEGORY_COUNT) break;
    const pages = await fetchCategoryPages(cat);
    // require at least TILES_PER_CATEGORY pages to consider this category
    if (pages && pages.length >= Math.max(5, TILES_PER_CATEGORY)) {
      chosen.push(cat);
      categoryPagesMap[cat] = pages;
    }
  }

  if (chosen.length < CATEGORY_COUNT) {
    loading.textContent = 'Could not find enough suitable categories. Try again.';
    return;
  }

  // Now we have chosen categories with their pages. Build the visual grid.
  boardEl.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'grid';

  // header row
  const headerRow = document.createElement('div');
  headerRow.className = 'row header-row';
  chosen.forEach(cat => {
    const h = document.createElement('div');
    h.className = 'category';
    h.textContent = cat;
    headerRow.appendChild(h);
  });
  grid.appendChild(headerRow);

  const tilesList = [];

  for (let row = 0; row < TILES_PER_CATEGORY; row++) {
    const rowEl = document.createElement('div');
    rowEl.className = 'row tiles-row';
    for (let col = 0; col < chosen.length; col++) {
      const category = chosen[col];
      const pages = categoryPagesMap[category] || [];
      const difficulty = row; // 0..2
      const page = choosePageByDifficulty(pages, difficulty) || pages[Math.floor(Math.random() * pages.length)];
      const item = page ? makeTileFromPage(page, category, difficulty) : { image: `https://source.unsplash.com/featured/?${encodeURIComponent(category)}`, question: `Name this ${singularize(category)}`, answer: category };

      const valueLabel = `${(row + 1) * 100}`;
      const tileContainer = document.createElement('div');
      tileContainer.className = 'tile-cell';
      const tileEl = createTileElement(item, valueLabel);
      tileContainer.appendChild(tileEl);
      rowEl.appendChild(tileContainer);

      tilesList.push(tileEl);
    }
    grid.appendChild(rowEl);
  }

  // mark one random tile as Daily Double
  if (tilesList.length > 0) {
    const idx = Math.floor(Math.random() * tilesList.length);
    const dd = tilesList[idx];
    dd.classList.add('daily');
    const label = document.createElement('div');
    label.className = 'daily-label';
    label.textContent = 'Daily';
    dd.appendChild(label);
  }

  boardEl.appendChild(grid);
}

function openModal(item) {
  modalImage.src = item.image;
  modalImage.alt = item.question || 'Question image';
  modalQuestion.textContent = item.question || '';
  modalAnswer.textContent = item.answer || '';
  modalAnswer.classList.add('hidden');
  modal.classList.remove('hidden');
}

function closeModal() { modal.classList.add('hidden'); }

function shuffleTiles() {
  const tiles = Array.from(boardEl.querySelectorAll('.tile'));
  const tileData = tiles.map(t => ({
    image: t.getAttribute('data-image'),
    question: t.getAttribute('data-question'),
    answer: t.getAttribute('data-answer'),
    innerHTML: t.innerHTML,
    classes: t.className
  }));
  tileData.sort(() => Math.random() - 0.5);
  tiles.forEach((t, i) => {
    t.setAttribute('data-image', tileData[i].image);
    t.setAttribute('data-question', tileData[i].question);
    t.setAttribute('data-answer', tileData[i].answer);
    t.innerHTML = tileData[i].innerHTML;
    t.className = tileData[i].classes;
  });
}

// UI wiring
newBoardBtn.addEventListener('click', buildBoard);
shuffleBtn.addEventListener('click', shuffleTiles);
closeModalBtn.addEventListener('click', closeModal);
showAnswerBtn.addEventListener('click', () => modalAnswer.classList.remove('hidden'));
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

// initial build
buildBoard();
