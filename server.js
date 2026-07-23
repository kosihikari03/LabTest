import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { createServer } from "node:http";

const rootDir = resolve(".");
const publicDir = join(rootDir, "public");
const dataDir = join(rootDir, "data");
const dataFile = join(dataDir, "store.json");
const port = Number(process.env.PORT || 3000);
const adminPassword = process.env.ADMIN_PASSWORD || "admin-reset";

const defaultLabs = [
  { id: "lab-a", name: "研究室A", min: 2, max: 5 },
  { id: "lab-b", name: "研究室B", min: 2, max: 5 },
  { id: "lab-c", name: "研究室C", min: 2, max: 5 },
  { id: "lab-d", name: "研究室D", min: 2, max: 5 }
];

const defaultStore = {
  accepting: true,
  labs: defaultLabs,
  registrationVersion: 1,
  students: [],
  updatedAt: new Date().toISOString()
};

function ensureStore() {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  if (!existsSync(dataFile)) saveStore(defaultStore);
}

function loadStore() {
  ensureStore();
  const store = JSON.parse(readFileSync(dataFile, "utf8"));
  if (!store.registrationVersion) store.registrationVersion = 1;
  return store;
}

function saveStore(store) {
  store.updatedAt = new Date().toISOString();
  writeFileSync(dataFile, JSON.stringify(store, null, 2));
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicStore(store) {
  const resultsPublished = !store.accepting;
  return {
    accepting: store.accepting,
    resultsPublished,
    labs: store.labs,
    registrationVersion: store.registrationVersion,
    participantCount: store.students.length,
    updatedAt: store.updatedAt,
    simulations: resultsPublished ? simulateAll(store) : []
  };
}

function normalizeGpa(value) {
  const gpa = Number(value);
  if (!Number.isFinite(gpa) || gpa < 0 || gpa > 4.5) {
    throw new Error("GPAは0.00から4.50の数値で入力してください。");
  }
  return Math.round(gpa * 100) / 100;
}

function normalizePreferences(value, labs) {
  if (!Array.isArray(value)) throw new Error("希望順位を選択してください。");
  const validIds = new Set(labs.map((lab) => lab.id));
  const seen = new Set();
  const prefs = value.filter(Boolean).map(String);
  for (const labId of prefs) {
    if (!validIds.has(labId)) throw new Error("存在しない研究室が含まれています。");
    if (seen.has(labId)) throw new Error("同じ研究室を複数回選ぶことはできません。");
    seen.add(labId);
  }
  if (!prefs.length) throw new Error("少なくとも第1希望を選択してください。");
  return prefs;
}

function normalizeLabs(labs) {
  if (!Array.isArray(labs) || !labs.length) throw new Error("研究室を1件以上設定してください。");
  const seen = new Set();
  return labs.map((lab, index) => {
    const name = String(lab.name || "").trim();
    const min = Number(lab.min);
    const max = Number(lab.max);
    if (!name) throw new Error(`${index + 1}行目の研究室名が空です。`);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < 1 || min > max) {
      throw new Error(`${name}の定員は 0 <= 最低 <= 最大 で入力してください。`);
    }
    const id = slugify(lab.id || name);
    if (seen.has(id)) throw new Error(`${name}のIDが重複しています。`);
    seen.add(id);
    return { id, name, min, max };
  });
}

function slugify(value) {
  const base = String(value).trim().toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `lab-${randomBytes(3).toString("hex")}`;
}

function makeAnonymousId(existingIds) {
  for (;;) {
    const id = `${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`;
    if (!existingIds.has(id)) return id;
  }
}

function makeEditKey() {
  return `${randomWord()}-${randomWord()}-${randomInt(1000, 9999)}`;
}

function randomWord() {
  const words = ["river", "cobalt", "maple", "signal", "lunar", "cedar", "mint", "orbit", "clear", "north"];
  return words[randomInt(0, words.length - 1)];
}

function randomInt(min, max) {
  return min + randomBytes(1)[0] % (max - min + 1);
}

function hashEditKey(key, salt = randomBytes(16).toString("hex")) {
  const hash = createHash("sha256").update(`${salt}:${key}`).digest("hex");
  return { salt, hash };
}

function verifyEditKey(student, key) {
  const expected = Buffer.from(student.editKeyHash, "hex");
  const actual = Buffer.from(hashEditKey(key, student.editKeySalt).hash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function studentView(student, store) {
  const placements = store.accepting
    ? null
    : Object.fromEntries(
      simulateAll(store).map((sim) => [sim.id, findPlacement(sim, student.anonymousId)])
    );
  return {
    anonymousId: student.anonymousId,
    gpa: student.gpa,
    preferences: student.preferences,
    placements,
    createdAt: student.createdAt,
    updatedAt: student.updatedAt
  };
}

function findPlacement(sim, anonymousId) {
  for (const lab of sim.labs) {
    if (lab.assigned.includes(anonymousId)) return lab.labId;
  }
  return sim.unassigned.includes(anonymousId) ? null : undefined;
}

function simulateAll(store) {
  const students = [...store.students].sort(byGpaThenCreated);
  return [
    simulateGreedyMax("gpa-max", "GPA順・最大定員モデル", students, store.labs),
    simulateMinAware(students, store.labs),
    simulatePreferenceOptimized(students, store.labs)
  ];
}

function byGpaThenCreated(a, b) {
  if (b.gpa !== a.gpa) return b.gpa - a.gpa;
  return String(a.createdAt).localeCompare(String(b.createdAt));
}

function emptyAssignment(labs) {
  return new Map(labs.map((lab) => [lab.id, []]));
}

function packSimulation(id, name, labs, assignments, unassigned, notes = []) {
  return {
    id,
    name,
    notes,
    labs: labs.map((lab) => ({
      labId: lab.id,
      name: lab.name,
      min: lab.min,
      max: lab.max,
      assigned: assignments.get(lab.id) || []
    })),
    unassigned
  };
}

function simulateGreedyMax(id, name, students, labs) {
  const assignments = emptyAssignment(labs);
  const labMap = new Map(labs.map((lab) => [lab.id, lab]));
  const unassigned = [];

  for (const student of students) {
    const labId = student.preferences.find((pref) => {
      const lab = labMap.get(pref);
      return lab && assignments.get(pref).length < lab.max;
    });
    if (labId) assignments.get(labId).push(student.anonymousId);
    else unassigned.push(student.anonymousId);
  }
  return packSimulation(id, name, labs, assignments, unassigned);
}

function simulateMinAware(students, labs) {
  const assignments = emptyAssignment(labs);
  const labMap = new Map(labs.map((lab) => [lab.id, lab]));
  const unassigned = [];

  for (let index = 0; index < students.length; index += 1) {
    const student = students[index];
    const remaining = students.length - index - 1;
    const deficits = labs.reduce((sum, lab) => sum + Math.max(0, lab.min - assignments.get(lab.id).length), 0);
    const mustFillMin = deficits >= remaining + 1;

    let candidates = student.preferences.filter((pref) => {
      const lab = labMap.get(pref);
      return lab && assignments.get(pref).length < lab.max;
    });

    if (mustFillMin) {
      const deficitCandidates = candidates.filter((pref) => assignments.get(pref).length < labMap.get(pref).min);
      if (deficitCandidates.length) candidates = deficitCandidates;
    }

    const labId = candidates[0];
    if (labId) assignments.get(labId).push(student.anonymousId);
    else unassigned.push(student.anonymousId);
  }

  const shortageCount = labs.filter((lab) => assignments.get(lab.id).length < lab.min).length;
  const notes = shortageCount ? [`最低人数未満の研究室が${shortageCount}件あります。`] : [];
  return packSimulation("min-aware", "最低人数考慮モデル", labs, assignments, unassigned, notes);
}

function simulatePreferenceOptimized(students, labs) {
  if (students.length > 12) {
    const fallback = simulateMinAware(students, labs);
    return { ...fallback, id: "preference-optimized", name: "希望順位最適化モデル", notes: ["参加者が多いため、近似計算として最低人数考慮モデルを表示しています。"] };
  }

  const labMap = new Map(labs.map((lab) => [lab.id, lab]));
  let best = null;

  function score(student, labId) {
    const rank = student.preferences.indexOf(labId);
    if (rank === -1) return 1000;
    return rank * 100 - student.gpa;
  }

  function search(index, assignments, unassigned, totalScore) {
    if (best && totalScore >= best.totalScore) return;
    if (index === students.length) {
      const feasible = labs.every((lab) => assignments.get(lab.id).length >= lab.min);
      if (!feasible) return;
      best = { assignments: cloneAssignments(assignments), unassigned: [...unassigned], totalScore };
      return;
    }

    const student = students[index];
    for (const labId of student.preferences) {
      const lab = labMap.get(labId);
      if (!lab || assignments.get(labId).length >= lab.max) continue;
      assignments.get(labId).push(student.anonymousId);
      search(index + 1, assignments, unassigned, totalScore + score(student, labId));
      assignments.get(labId).pop();
    }

    unassigned.push(student.anonymousId);
    search(index + 1, assignments, unassigned, totalScore + 10000);
    unassigned.pop();
  }

  search(0, emptyAssignment(labs), [], 0);

  if (!best) {
    const fallback = simulateGreedyMax("preference-optimized", "希望順位最適化モデル", students, labs);
    return { ...fallback, notes: ["最低人数をすべて満たす割当が見つからないため、最大定員モデルを表示しています。"] };
  }

  return packSimulation("preference-optimized", "希望順位最適化モデル", labs, best.assignments, best.unassigned);
}

function cloneAssignments(assignments) {
  return new Map([...assignments.entries()].map(([labId, ids]) => [labId, [...ids]]));
}

async function handleApi(req, res, path) {
  try {
    if (req.method === "GET" && path === "/api/public") {
      return json(res, 200, publicStore(loadStore()));
    }

    if (req.method === "POST" && path === "/api/register") {
      const store = loadStore();
      if (!store.accepting) return json(res, 403, { error: "受付は停止中です。" });
      const body = await readJson(req);
      const gpa = normalizeGpa(body.gpa);
      const preferences = normalizePreferences(body.preferences, store.labs);
      const existingIds = new Set(store.students.map((student) => student.anonymousId));
      const anonymousId = makeAnonymousId(existingIds);
      const editKey = makeEditKey();
      const { salt, hash } = hashEditKey(editKey);
      const now = new Date().toISOString();
      store.students.push({
        anonymousId,
        editKeySalt: salt,
        editKeyHash: hash,
        gpa,
        preferences,
        createdAt: now,
        updatedAt: now
      });
      saveStore(store);
      return json(res, 201, { anonymousId, editKey });
    }

    if (req.method === "POST" && path === "/api/mine") {
      const store = loadStore();
      const body = await readJson(req);
      const student = store.students.find((item) => item.anonymousId === String(body.anonymousId || "").trim().toUpperCase());
      if (!student || !verifyEditKey(student, String(body.editKey || ""))) {
        return json(res, 403, { error: "匿名IDまたは編集キーが違います。" });
      }
      return json(res, 200, studentView(student, store));
    }

    if (req.method === "PUT" && path === "/api/mine") {
      const store = loadStore();
      if (!store.accepting) return json(res, 403, { error: "受付は停止中です。" });
      const body = await readJson(req);
      const student = store.students.find((item) => item.anonymousId === String(body.anonymousId || "").trim().toUpperCase());
      if (!student || !verifyEditKey(student, String(body.editKey || ""))) {
        return json(res, 403, { error: "匿名IDまたは編集キーが違います。" });
      }
      student.gpa = normalizeGpa(body.gpa);
      student.preferences = normalizePreferences(body.preferences, store.labs);
      student.updatedAt = new Date().toISOString();
      saveStore(store);
      return json(res, 200, studentView(student, store));
    }

    if (req.method === "DELETE" && path === "/api/mine") {
      const store = loadStore();
      const body = await readJson(req);
      const index = store.students.findIndex((item) => item.anonymousId === String(body.anonymousId || "").trim().toUpperCase());
      if (index === -1 || !verifyEditKey(store.students[index], String(body.editKey || ""))) {
        return json(res, 403, { error: "匿名IDまたは編集キーが違います。" });
      }
      store.students.splice(index, 1);
      saveStore(store);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/admin") {
      const store = loadStore();
      const body = await readJson(req);
      if (String(body.password || "") !== adminPassword) return json(res, 403, { error: "管理者パスワードが違います。" });
      return json(res, 200, {
        accepting: store.accepting,
        labs: store.labs,
        participantCount: store.students.length,
        updatedAt: store.updatedAt
      });
    }

    if (req.method === "PUT" && path === "/api/admin/settings") {
      const store = loadStore();
      const body = await readJson(req);
      if (String(body.password || "") !== adminPassword) return json(res, 403, { error: "管理者パスワードが違います。" });
      store.accepting = Boolean(body.accepting);
      store.labs = normalizeLabs(body.labs);
      store.students = store.students.map((student) => ({
        ...student,
        preferences: student.preferences.filter((labId) => store.labs.some((lab) => lab.id === labId))
      })).filter((student) => student.preferences.length);
      saveStore(store);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && path === "/api/admin/reset") {
      const store = loadStore();
      const body = await readJson(req);
      if (String(body.password || "") !== adminPassword) return json(res, 403, { error: "管理者パスワードが違います。" });
      if (String(body.confirm || "") !== "RESET") return json(res, 400, { error: "確認欄に RESET と入力してください。" });
      store.students = [];
      store.registrationVersion = (store.registrationVersion || 1) + 1;
      saveStore(store);
      return json(res, 200, { ok: true });
    }

    return notFound(res);
  } catch (error) {
    return json(res, 400, { error: error.message || "エラーが発生しました。" });
  }
}

function serveStatic(req, res, path) {
  const requestedPath = path === "/" ? "/index.html" : path;
  const filePath = resolve(publicDir, `.${requestedPath}`);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) return notFound(res);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  };
  res.writeHead(200, {
    "content-type": types[extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store"
  });
  res.end(readFileSync(filePath));
}

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url.pathname);
  return serveStatic(req, res, url.pathname);
}).listen(port, () => {
  ensureStore();
  console.log(`Lab placement simulator: http://localhost:${port}`);
  console.log(`Admin password: ${adminPassword}`);
});
