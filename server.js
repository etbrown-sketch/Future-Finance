import http from 'node:http';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST_PASSWORD = process.env.HOST_PASSWORD || '123';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const PUBLIC_DIR = path.join(__dirname, 'public');
const STORAGE_DIR = path.join(__dirname, 'storage');
const UPLOAD_DIR = path.join(STORAGE_DIR, 'uploads');
const DB_PATH = path.join(STORAGE_DIR, 'db.json');

const DEFAULT_DB = Object.freeze({
  caseStudy: null,
  submissions: []
});

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendText(res, statusCode, message) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(message);
}

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    '.csv': 'text/csv; charset=utf-8'
  };
  return types[ext] || 'application/octet-stream';
}

function safeOriginalFilename(filename) {
  const fallback = 'uploaded-file';
  const base = path.basename(String(filename || fallback));
  const cleaned = base.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function uniqueStoredFilename(originalName, prefix = 'file') {
  const safe = safeOriginalFilename(originalName);
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}-${safe}`;
}

async function ensureStorage() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    await fs.access(DB_PATH);
  } catch {
    await writeDb({ ...DEFAULT_DB });
  }
}

async function readDb() {
  await ensureStorage();
  try {
    const raw = await fs.readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      caseStudy: parsed.caseStudy || null,
      submissions: Array.isArray(parsed.submissions) ? parsed.submissions : []
    };
  } catch {
    return { ...DEFAULT_DB, submissions: [] };
  }
}

async function writeDb(db) {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2));
  await fs.rename(tmp, DB_PATH);
}

function publicCaseStudy(caseStudy) {
  if (!caseStudy) return null;
  return {
    fileName: caseStudy.fileName,
    fileSize: caseStudy.fileSize,
    mimeType: caseStudy.mimeType,
    publishedAt: caseStudy.publishedAt,
    checklist: caseStudy.checklist,
    customGptUrl: caseStudy.customGptUrl || ''
  };
}

function parseChecklist(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((text, index) => ({
    id: `task-${index + 1}-${crypto.randomUUID().slice(0, 8)}`,
    text
  }));
}

async function parseJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) throw Object.assign(new Error('Request body is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON body.'), { statusCode: 400 });
  }
}

function splitBuffer(buffer, delimiter) {
  const pieces = [];
  let start = 0;
  let index = buffer.indexOf(delimiter, start);
  while (index !== -1) {
    pieces.push(buffer.subarray(start, index));
    start = index + delimiter.length;
    index = buffer.indexOf(delimiter, start);
  }
  pieces.push(buffer.subarray(start));
  return pieces;
}

function parseContentDisposition(value) {
  const output = {};
  const parts = String(value || '').split(';').map((part) => part.trim());
  output.type = parts.shift() || '';
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let val = part.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    output[key] = val;
  }
  return output;
}

async function parseMultipart(req) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw Object.assign(new Error('Expected multipart/form-data.'), { statusCode: 400 });

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) {
      throw Object.assign(new Error(`Upload exceeds ${MAX_UPLOAD_MB} MB limit.`), { statusCode: 413 });
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks);
  const delimiter = Buffer.from(`--${boundary}`);
  const rawParts = splitBuffer(body, delimiter);
  const fields = {};
  const files = {};

  for (let part of rawParts) {
    if (!part.length) continue;
    if (part.subarray(0, 2).toString('latin1') === '\r\n') part = part.subarray(2);
    if (part.subarray(0, 2).toString('latin1') === '--') continue;
    if (part.subarray(part.length - 2).toString('latin1') === '\r\n') part = part.subarray(0, part.length - 2);

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) continue;

    const headerText = part.subarray(0, headerEnd).toString('latin1');
    const content = part.subarray(headerEnd + 4);
    const headers = {};
    for (const line of headerText.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon === -1) continue;
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }

    const disposition = parseContentDisposition(headers['content-disposition']);
    const name = disposition.name;
    if (!name) continue;

    if (Object.prototype.hasOwnProperty.call(disposition, 'filename')) {
      if (!disposition.filename) continue;
      files[name] = {
        filename: safeOriginalFilename(disposition.filename),
        mimeType: headers['content-type'] || 'application/octet-stream',
        size: content.length,
        buffer: Buffer.from(content)
      };
    } else {
      fields[name] = content.toString('utf8');
    }
  }

  return { fields, files };
}

function isHostRequest(req, searchParams) {
  const headerPassword = req.headers['x-host-password'];
  const queryPassword = searchParams.get('password');
  return headerPassword === HOST_PASSWORD || queryPassword === HOST_PASSWORD;
}

function classifyPrompt(message) {
  const text = String(message || '').trim().toLowerCase();
  if (!text) return 'empty';

  const locationPattern = /\b(where|find|locate|which tab|which sheet|source|look for|where should i start|what should i check)\b/i;
  const debuggingPattern = /\b(stuck|error|wrong|debug|not working|#ref|#value|#n\/a|broken|circular reference|formula error)\b/i;
  const conceptPattern = /\b(explain|understand|formula|method|approach|ratio|margin|variance|forecast|budget|cash flow|working capital|revenue|expense|ebitda|depreciation|capex|assumption)\b/i;
  const planningPattern = /\b(plan|steps|sequence|prioritize|next|review|checklist|rubric|organize)\b/i;
  const directAnswerPattern = /\b(just\s+)?(give|tell|send|provide)\s+(me\s+)?(the\s+)?(answer|answers|final|number|result|solution)\b|\b(do|complete|fill\s+out|solve|calculate|build|make)\s+(it|this|the\s+case|the\s+workbook|the\s+model|the\s+excel|the\s+spreadsheet|for\s+me)\b|\bwhat\s+(is|are)\s+(the\s+)?(answer|answers|final|exact)\b|\bcopy\s*[- ]?paste\b/i;

  if (locationPattern.test(text)) return 'location-guidance';
  if (debuggingPattern.test(text)) return 'debugging';
  if (conceptPattern.test(text)) return 'conceptual-help';
  if (planningPattern.test(text)) return 'planning';
  if (directAnswerPattern.test(text)) return 'answer-seeking';
  if (text.length < 24) return 'vague';
  return 'general-coaching';
}

function summarizeChecklist(checklist, completedIds) {
  const completed = new Set(Array.isArray(completedIds) ? completedIds : []);
  const nextTask = (checklist || []).find((task) => !completed.has(task.id));
  const completedCount = (checklist || []).filter((task) => completed.has(task.id)).length;
  return {
    nextTask,
    completedCount,
    totalCount: Array.isArray(checklist) ? checklist.length : 0
  };
}

function generateAiBossReply({ message, checklist = [], completedIds = [] }) {
  const category = classifyPrompt(message);
  const { nextTask, completedCount, totalCount } = summarizeChecklist(checklist, completedIds);
  const progressLine = totalCount
    ? `You have marked ${completedCount} of ${totalCount} checklist items complete.`
    : 'Use the host checklist as your roadmap once it is available.';
  const nextLine = nextTask ? `A useful next checkpoint is: "${nextTask.text}".` : 'You appear to have marked every checklist item complete; now audit your work before submitting.';

  let reply;
  switch (category) {
    case 'answer-seeking':
      reply = `I cannot provide final answers, exact values, or fill out the workbook for you. ${progressLine} ${nextLine} Tell me what sheet, cell range, or assumption you are reviewing and what you have already tried; I can help you choose the next check.`;
      break;
    case 'location-guidance':
      reply = `Start by matching the wording of the checklist item to the workbook tabs and any assumption or source-data sections. ${nextLine} Look for labels, dates, units, and subtotals before building formulas. I can help you narrow the search if you describe the tabs you see.`;
      break;
    case 'debugging':
      reply = `Good debugging request. Do not change numbers yet. First check that the formula points to the intended range, uses consistent time periods, and handles signs correctly for revenue, expenses, assets, and liabilities. ${nextLine} Share the structure of your formula without asking me to compute the final value.`;
      break;
    case 'conceptual-help':
      reply = `Here is the method without doing the work: identify the driver, confirm the unit, select the matching source data, then build a formula that can be copied across periods. ${nextLine} After that, sanity-check the direction and magnitude against the case context.`;
      break;
    case 'planning':
      reply = `Use this sequence: read the instructions, identify required outputs, map each output to the workbook source tabs, complete one checklist item at a time, then review formulas and assumptions. ${progressLine} ${nextLine}`;
      break;
    case 'vague':
      reply = `I need a more specific coaching question. Try: "I am on checklist item X, I found Y on tab Z, and I think the next step is..." ${nextLine}`;
      break;
    case 'empty':
      reply = 'Type a coaching question and I will guide your next step without giving final answers.';
      break;
    default:
      reply = `I can coach your process, point you toward source information, and help you verify your reasoning. ${progressLine} ${nextLine} Ask for hints, checks, or concepts rather than final answers.`;
  }

  return { category, reply };
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function generateSubmissionReport({ studentName, checklist = [], completedIds = [], interactions = [] }) {
  const completedSet = new Set(Array.isArray(completedIds) ? completedIds : []);
  const totalChecklist = checklist.length;
  const completedCount = checklist.filter((task) => completedSet.has(task.id)).length;
  const progressPercent = totalChecklist ? Math.round((completedCount / totalChecklist) * 100) : 0;

  const studentMessages = interactions.filter((entry) => entry && entry.role === 'student');
  const categories = countBy(studentMessages, (entry) => entry.category || classifyPrompt(entry.text));
  const totalPrompts = studentMessages.length;
  const directCount = categories['answer-seeking'] || 0;
  const productiveCount = (categories['location-guidance'] || 0) + (categories['conceptual-help'] || 0) + (categories.debugging || 0) + (categories.planning || 0) + (categories['general-coaching'] || 0);
  const vagueCount = categories.vague || 0;
  const directRatio = totalPrompts ? directCount / totalPrompts : 0;
  const productiveRatio = totalPrompts ? productiveCount / totalPrompts : 0;

  let rating = 'Productive coaching use';
  let risk = 'Low';
  let pattern = 'The student generally used the AI Boss for process guidance, concept clarification, or debugging rather than final answers.';
  let hostFollowUp = 'Compare workbook quality against the checklist and ask the student to explain one key assumption.';

  if (totalPrompts === 0) {
    rating = 'No AI interaction logged';
    risk = 'Unknown';
    pattern = 'The student submitted without using the AI Boss in this session.';
    hostFollowUp = 'Review the workbook directly and ask how the student approached the case.';
  } else if (directCount >= 3 || directRatio >= 0.34) {
    rating = 'High dependency risk';
    risk = 'High';
    pattern = 'The student repeatedly asked for final answers, exact values, or for the AI Boss to complete work. The AI Boss redirected those requests.';
    hostFollowUp = 'Ask the student to walk through their reasoning and verify that they can reproduce the work independently.';
  } else if (directCount > 0 || vagueCount >= Math.max(2, Math.ceil(totalPrompts / 3))) {
    rating = 'Needs more precise coaching habits';
    risk = 'Moderate';
    pattern = 'The student had some answer-seeking or vague prompts, but also used coaching prompts that can support learning.';
    hostFollowUp = 'Coach the student to ask for source-location help, formula checks, and reasoning validation instead of broad hints.';
  } else if (progressPercent < 70) {
    rating = 'Under-completed checklist';
    risk = 'Moderate';
    pattern = 'The AI interaction pattern looked appropriate, but the submitted checklist progress was incomplete.';
    hostFollowUp = 'Review missing checklist items before comparing this submission with fully completed cases.';
  } else if (productiveRatio >= 0.75 && progressPercent >= 90) {
    rating = 'Strong independent use';
    risk = 'Low';
    pattern = 'The student used the AI Boss mostly for source-finding, planning, conceptual explanation, or debugging while completing most checklist items.';
    hostFollowUp = 'Use this submission as a candidate for deeper content review and peer comparison.';
  }

  return {
    rating,
    risk,
    pattern,
    hostFollowUp,
    stats: {
      totalPrompts,
      answerSeekingPrompts: directCount,
      productiveCoachingPrompts: productiveCount,
      vaguePrompts: vagueCount,
      progressPercent,
      completedChecklistItems: completedCount,
      totalChecklistItems: totalChecklist
    },
    shortComparisonLine: `${studentName || 'Student'}: ${rating}; ${progressPercent}% checklist completion; ${directCount}/${totalPrompts} answer-seeking prompts.`
  };
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function submissionsToCsv(submissions) {
  const headers = [
    'Student',
    'Submitted At',
    'File Name',
    'Checklist Progress',
    'AI Rating',
    'Risk',
    'Total Prompts',
    'Answer Seeking Prompts',
    'Productive Coaching Prompts',
    'Summary',
    'Host Follow Up'
  ];
  const rows = submissions.map((submission) => {
    const stats = submission.report?.stats || {};
    return [
      submission.studentName,
      submission.submittedAt,
      submission.fileName,
      `${stats.progressPercent ?? 0}%`,
      submission.report?.rating || '',
      submission.report?.risk || '',
      stats.totalPrompts ?? 0,
      stats.answerSeekingPrompts ?? 0,
      stats.productiveCoachingPrompts ?? 0,
      submission.report?.pattern || '',
      submission.report?.hostFollowUp || ''
    ];
  });
  return [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\n');
}

async function saveUploadedFile(file, prefix) {
  const storedName = uniqueStoredFilename(file.filename, prefix);
  const storedPath = path.join(UPLOAD_DIR, storedName);
  await fs.writeFile(storedPath, file.buffer);
  return {
    storedName,
    storedPath,
    fileName: file.filename,
    mimeType: file.mimeType || getMime(file.filename),
    fileSize: file.size
  };
}

async function serveStatic(req, res, pathname) {
  let requested = decodeURIComponent(pathname);
  if (requested === '/') requested = '/index.html';
  const resolved = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!resolved.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) return sendText(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': getMime(resolved),
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    createReadStream(resolved).pipe(res);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

async function streamStoredFile(res, storedName, originalName, mimeType) {
  const resolved = path.resolve(UPLOAD_DIR, storedName);
  if (!resolved.startsWith(UPLOAD_DIR)) return sendText(res, 403, 'Forbidden');
  try {
    const stat = await fs.stat(resolved);
    res.writeHead(200, {
      'Content-Type': mimeType || getMime(originalName),
      'Content-Length': stat.size,
      'Content-Disposition': `attachment; filename="${safeOriginalFilename(originalName).replace(/"/g, '')}"`,
      'Cache-Control': 'no-store'
    });
    createReadStream(resolved).pipe(res);
  } catch {
    sendText(res, 404, 'File not found');
  }
}

async function handleApi(req, res, pathname, searchParams) {
  if (req.method === 'GET' && pathname === '/api/status') {
    const db = await readDb();
    return sendJson(res, 200, {
      caseStudy: publicCaseStudy(db.caseStudy),
      submissionCount: db.submissions.length
    });
  }

  if (req.method === 'POST' && pathname === '/api/host/login') {
    const body = await parseJsonBody(req);
    if (body.password === HOST_PASSWORD) return sendJson(res, 200, { ok: true });
    return sendJson(res, 401, { ok: false, error: 'Incorrect password.' });
  }

  if (req.method === 'GET' && pathname === '/api/case-file') {
    const db = await readDb();
    if (!db.caseStudy) return sendText(res, 404, 'No case study has been published.');
    return streamStoredFile(res, db.caseStudy.storedName, db.caseStudy.fileName, db.caseStudy.mimeType);
  }

  if (req.method === 'POST' && pathname === '/api/ai-boss') {
    const db = await readDb();
    if (!db.caseStudy) return sendJson(res, 409, { error: 'No case study is published yet.' });
    const body = await parseJsonBody(req);
    const result = generateAiBossReply({
      message: body.message,
      checklist: db.caseStudy.checklist || [],
      completedIds: Array.isArray(body.completedIds) ? body.completedIds : []
    });
    return sendJson(res, 200, result);
  }

  if (req.method === 'POST' && pathname === '/api/host/publish') {
    if (!isHostRequest(req, searchParams)) return sendJson(res, 401, { error: 'Host password required.' });
    const { fields, files } = await parseMultipart(req);
    const caseFile = files.caseFile;
    if (!caseFile) return sendJson(res, 400, { error: 'Upload an Excel case document.' });

    const allowedExtensions = new Set(['.xlsx', '.xls', '.xlsm', '.csv']);
    if (!allowedExtensions.has(path.extname(caseFile.filename).toLowerCase())) {
      return sendJson(res, 400, { error: 'Case document must be .xlsx, .xls, .xlsm, or .csv.' });
    }

    const checklist = parseChecklist(fields.checklistText);
    if (!checklist.length) return sendJson(res, 400, { error: 'Add at least one checklist instruction.' });

    const saved = await saveUploadedFile(caseFile, 'case');
    const db = await readDb();
    db.caseStudy = {
      ...saved,
      publishedAt: new Date().toISOString(),
      customGptUrl: String(fields.customGptUrl || '').trim(),
      checklist
    };

    if (fields.clearSubmissions === 'true') {
      db.submissions = [];
    }

    await writeDb(db);
    return sendJson(res, 200, { ok: true, caseStudy: publicCaseStudy(db.caseStudy) });
  }

  if (req.method === 'POST' && pathname === '/api/submissions') {
    const db = await readDb();
    if (!db.caseStudy) return sendJson(res, 409, { error: 'No case study is published yet.' });

    const { fields, files } = await parseMultipart(req);
    const submissionFile = files.submissionFile;
    const studentName = String(fields.studentName || '').trim();
    if (!studentName) return sendJson(res, 400, { error: 'Student name is required.' });
    if (!submissionFile) return sendJson(res, 400, { error: 'Upload your completed case study document.' });

    let completedIds = [];
    let interactions = [];
    try {
      completedIds = JSON.parse(fields.completedIds || '[]');
      interactions = JSON.parse(fields.interactions || '[]');
    } catch {
      return sendJson(res, 400, { error: 'Invalid submission metadata.' });
    }

    const saved = await saveUploadedFile(submissionFile, 'submission');
    const report = generateSubmissionReport({
      studentName,
      checklist: db.caseStudy.checklist || [],
      completedIds,
      interactions
    });

    const submission = {
      id: crypto.randomUUID(),
      studentName,
      submittedAt: new Date().toISOString(),
      fileName: saved.fileName,
      storedName: saved.storedName,
      mimeType: saved.mimeType,
      fileSize: saved.fileSize,
      completedIds,
      interactions,
      report
    };

    db.submissions.unshift(submission);
    await writeDb(db);

    return sendJson(res, 200, {
      ok: true,
      submission: {
        id: submission.id,
        studentName: submission.studentName,
        submittedAt: submission.submittedAt,
        fileName: submission.fileName,
        report: submission.report
      }
    });
  }

  if (req.method === 'GET' && pathname === '/api/host/submissions') {
    if (!isHostRequest(req, searchParams)) return sendJson(res, 401, { error: 'Host password required.' });
    const db = await readDb();
    const submissions = db.submissions.map((submission) => ({
      id: submission.id,
      studentName: submission.studentName,
      submittedAt: submission.submittedAt,
      fileName: submission.fileName,
      fileSize: submission.fileSize,
      report: submission.report,
      interactionCount: Array.isArray(submission.interactions) ? submission.interactions.length : 0
    }));
    return sendJson(res, 200, { submissions });
  }

  if (req.method === 'GET' && pathname === '/api/host/export.csv') {
    if (!isHostRequest(req, searchParams)) return sendText(res, 401, 'Host password required.');
    const db = await readDb();
    const csv = submissionsToCsv(db.submissions);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="turner-finance-futures-submissions.csv"',
      'Cache-Control': 'no-store'
    });
    return res.end(csv);
  }

  if (req.method === 'GET' && pathname.startsWith('/api/submission-file/')) {
    if (!isHostRequest(req, searchParams)) return sendText(res, 401, 'Host password required.');
    const id = pathname.split('/').pop();
    const db = await readDb();
    const submission = db.submissions.find((item) => item.id === id);
    if (!submission) return sendText(res, 404, 'Submission not found.');
    return streamStoredFile(res, submission.storedName, submission.fileName, submission.mimeType);
  }

  if (req.method === 'POST' && pathname === '/api/host/reset') {
    if (!isHostRequest(req, searchParams)) return sendJson(res, 401, { error: 'Host password required.' });
    await fs.rm(UPLOAD_DIR, { recursive: true, force: true });
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await writeDb({ ...DEFAULT_DB, submissions: [] });
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: 'API route not found.' });
}

async function requestHandler(req, res) {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname, url.searchParams);
    }

    return await serveStatic(req, res, pathname);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const message = statusCode >= 500 ? 'Server error.' : error.message;
    if (statusCode >= 500) console.error(error);
    return sendJson(res, statusCode, { error: message });
  }
}

await ensureStorage();
const server = http.createServer(requestHandler);
server.listen(PORT, () => {
  console.log(`Turner Finance Futures Program running at http://localhost:${PORT}`);
});
