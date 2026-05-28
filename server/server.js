const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { queryAll, queryOne, run } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'kaoyan-together-secret-2025!@#';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 托管前端静态文件
const publicDir = path.join(__dirname, '..');
app.use(express.static(publicDir));

// ============================================================
//  中间件
// ============================================================
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  try {
    const decoded = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    req.userId = decoded.userId;
    req.username = decoded.username;
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// ============================================================
//  认证
// ============================================================
app.post('/api/auth/register', (req, res) => {
  try {
    const { username, password, avatar, school } = req.body;
    if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
    if (password.length < 4) return res.status(400).json({ error: '密码至少4位' });

    if (queryOne('SELECT id FROM users WHERE username = ?', [username])) {
      return res.status(409).json({ error: '该用户名已被注册' });
    }

    const hashed = bcrypt.hashSync(password, 10);
    const r = run('INSERT INTO users (username, password, avatar, school) VALUES (?, ?, ?, ?)',
      [username, hashed, avatar || '🧑‍🎓', school || '']);
    const userId = r.lastInsertRowid;

    const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: '365d' });

    res.json({
      token,
      user: { id: userId, username, avatar: avatar || '🧑‍🎓', school: school || '',
              bio: '考研人，正在努力中！', target_school: '', daily_goal: 4,
              exam_date: '2025-12-20', subjects: '政治,英语,数学,专业课' }
    });
  } catch (e) {
    console.error('Register error:', e);
    res.status(500).json({ error: '注册失败，请重试' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

    const user = queryOne('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '365d' });

    const { password: _, ...profile } = user;
    res.json({ token, user: profile });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: '登录失败，请重试' });
  }
});

// ============================================================
//  用户资料
// ============================================================
app.get('/api/user/profile', authMiddleware, (req, res) => {
  try {
    const user = queryOne('SELECT id, username, avatar, school, bio, target_school, daily_goal, exam_date, subjects, created_at FROM users WHERE id = ?', [req.userId]);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    const checkins = queryAll('SELECT * FROM checkins WHERE user_id = ? ORDER BY date DESC', [req.userId]);
    const timers = queryAll('SELECT * FROM timer_sessions WHERE user_id = ? ORDER BY date DESC, created_at DESC', [req.userId]);
    const todos = queryAll('SELECT * FROM todos WHERE user_id = ? ORDER BY created_at DESC', [req.userId]);
    const scores = queryAll('SELECT * FROM exam_scores WHERE user_id = ? ORDER BY date DESC', [req.userId]);
    const today = new Date().toISOString().slice(0, 10);
    const todayPlan = queryOne('SELECT * FROM daily_plans WHERE user_id = ? AND date = ?', [req.userId, today]);

    const records = checkins.map(c => c.date);
    const notes = {}, moods = {}, reflections = {};
    checkins.forEach(c => {
      if (c.note) notes[c.date] = c.note;
      if (c.mood) moods[c.date] = c.mood;
      if (c.reflection) reflections[c.date] = c.reflection;
    });

    res.json({
      user,
      data: {
        records, notes, moods, reflections,
        timerLogs: timers.map(t => ({ date: t.date, seconds: t.seconds, subject: t.subject, mode: t.mode })),
        todos: todos.filter(t => !t.done).map(t => t.text),
        todoDone: todos.filter(t => t.done).reduce((acc, t) => { acc[t.text] = true; return acc; }, {}),
        scores: scores.map(s => ({ id: s.id, date: s.date, subject: s.subject, exam_name: s.exam_name, score: s.score, total: s.total, note: s.note })),
        todayPlan: todayPlan ? { goals: JSON.parse(todayPlan.goals || '[]'), completed: JSON.parse(todayPlan.completed || '[]'), summary: todayPlan.summary } : null
      }
    });
  } catch (e) {
    console.error('Profile error:', e);
    res.status(500).json({ error: '获取数据失败' });
  }
});

app.put('/api/user/profile', authMiddleware, (req, res) => {
  try {
    const { avatar, school, bio, target_school, daily_goal, exam_date, subjects } = req.body;
    run(
      'UPDATE users SET avatar=?, school=?, bio=?, target_school=?, daily_goal=?, exam_date=?, subjects=? WHERE id=?',
      [avatar || '🧑‍🎓', school || '', bio || '考研人，正在努力中！', target_school || '', daily_goal || 4, exam_date || '2025-12-20', subjects || '政治,英语,数学,专业课', req.userId]
    );
    const updated = queryOne('SELECT id, username, avatar, school, bio, target_school, daily_goal, exam_date, subjects FROM users WHERE id = ?', [req.userId]);
    res.json({ success: true, user: updated });
  } catch (e) {
    res.status(500).json({ error: '更新失败' });
  }
});

// ============================================================
//  打卡
// ============================================================
app.post('/api/checkin', authMiddleware, (req, res) => {
  try {
    const { date, note, mood, hours } = req.body;
    if (!date) return res.status(400).json({ error: '日期不能为空' });

    run('INSERT OR REPLACE INTO checkins (user_id, date, note, mood, hours) VALUES (?, ?, ?, ?, ?)',
      [req.userId, date, note || '', mood || '', hours || 0]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '打卡失败' });
  }
});

// 打卡复盘
app.put('/api/checkin/:date/reflection', authMiddleware, (req, res) => {
  try {
    const { reflection } = req.body;
    run('UPDATE checkins SET reflection=? WHERE user_id=? AND date=?',
      [reflection || '', req.userId, req.params.date]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '保存复盘失败' });
  }
});

// ============================================================
//  每日计划
// ============================================================
app.get('/api/plans/:date', authMiddleware, (req, res) => {
  const plan = queryOne('SELECT * FROM daily_plans WHERE user_id=? AND date=?', [req.userId, req.params.date]);
  res.json(plan ? { goals: JSON.parse(plan.goals || '[]'), completed: JSON.parse(plan.completed || '[]'), summary: plan.summary } : { goals: [], completed: [], summary: '' });
});

app.put('/api/plans/:date', authMiddleware, (req, res) => {
  try {
    const { goals, completed, summary } = req.body;
    run('INSERT OR REPLACE INTO daily_plans (user_id, date, goals, completed, summary) VALUES (?, ?, ?, ?, ?)',
      [req.userId, req.params.date, JSON.stringify(goals || []), JSON.stringify(completed || []), summary || '']);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '保存计划失败' });
  }
});

// ============================================================
//  成绩追踪
// ============================================================
app.get('/api/scores', authMiddleware, (req, res) => {
  const rows = queryAll('SELECT * FROM exam_scores WHERE user_id=? ORDER BY date DESC', [req.userId]);
  res.json({ scores: rows });
});

app.post('/api/scores', authMiddleware, (req, res) => {
  try {
    const { date, subject, exam_name, score, total, note } = req.body;
    if (!date || !subject || score == null) return res.status(400).json({ error: '参数不完整' });
    const r = run('INSERT INTO exam_scores (user_id, date, subject, exam_name, score, total, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [req.userId, date, subject, exam_name || '', score, total || 100, note || '']);
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: '保存成绩失败' });
  }
});

app.delete('/api/scores/:id', authMiddleware, (req, res) => {
  run('DELETE FROM exam_scores WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  res.json({ success: true });
});

// ============================================================
//  排行榜
// ============================================================
app.get('/api/checkins/leaderboard', authMiddleware, (req, res) => {
  try {
    const period = req.query.period || 'alltime';
    const now = new Date();
    let dateFilter = '', timerDateFilter = '';

    if (period === 'weekly') {
      const day = now.getDay();
      const monday = new Date(now);
      monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
      const mondayStr = monday.toISOString().slice(0, 10);
      dateFilter = ` AND c.date >= '${mondayStr}'`;
      timerDateFilter = ` AND t.date >= '${mondayStr}'`;
    } else if (period === 'monthly') {
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      dateFilter = ` AND c.date LIKE '${month}%'`;
      timerDateFilter = ` AND t.date LIKE '${month}%'`;
    }

    const rows = queryAll(`
      SELECT u.id, u.username, u.avatar, u.school, u.target_school,
             COUNT(DISTINCT c.date) as days,
             COALESCE(SUM(c.hours), 0) as total_hours,
             COALESCE((SELECT SUM(seconds) FROM timer_sessions t WHERE t.user_id = u.id ${timerDateFilter}), 0) as total_seconds
      FROM users u
      LEFT JOIN checkins c ON c.user_id = u.id ${dateFilter}
      GROUP BY u.id
      ORDER BY days DESC, total_hours DESC
      LIMIT 100
    `);
    res.json({ period, leaderboard: rows });
  } catch (e) {
    console.error('Leaderboard error:', e);
    res.status(500).json({ error: '获取排行榜失败' });
  }
});

// ============================================================
//  动态
// ============================================================
app.get('/api/checkins/feed', authMiddleware, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 30, 100);
    const rows = queryAll(`
      SELECT c.date, c.note, c.mood, c.hours, c.reflection,
             u.username, u.avatar, u.school
      FROM checkins c JOIN users u ON c.user_id = u.id
      ORDER BY c.created_at DESC LIMIT ?
    `, [limit]);

    res.json({ feeds: rows });
  } catch (e) {
    console.error('Feed error:', e);
    res.status(500).json({ error: '获取动态失败' });
  }
});

// ============================================================
//  自习室
// ============================================================
app.get('/api/checkins/room', authMiddleware, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = queryAll(`
      SELECT u.id, u.username, u.avatar, u.school,
             COALESCE((SELECT SUM(seconds) FROM timer_sessions WHERE user_id = u.id AND date = ?), 0) as today_seconds
      FROM checkins c JOIN users u ON c.user_id = u.id
      WHERE c.date = ?
      GROUP BY u.id
      ORDER BY today_seconds DESC LIMIT 50
    `, [today, today]);

    res.json({ today, users: rows });
  } catch (e) {
    console.error('Room error:', e);
    res.status(500).json({ error: '获取自习室失败' });
  }
});

// ============================================================
//  计时器
// ============================================================
app.post('/api/timer/sessions', authMiddleware, (req, res) => {
  try {
    const { date, seconds, subject, mode } = req.body;
    if (!date || !seconds) return res.status(400).json({ error: '参数不完整' });
    run('INSERT INTO timer_sessions (user_id, date, seconds, subject, mode) VALUES (?, ?, ?, ?, ?)',
      [req.userId, date, seconds, subject || '', mode || 'pomo']);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

// ============================================================
//  待办事项
// ============================================================
app.get('/api/todos', authMiddleware, (req, res) => {
  const todos = queryAll('SELECT * FROM todos WHERE user_id = ? ORDER BY created_at DESC', [req.userId]);
  res.json({ todos });
});

app.post('/api/todos', authMiddleware, (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: '内容不能为空' });
    const r = run('INSERT INTO todos (user_id, text) VALUES (?, ?)', [req.userId, text]);
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: '添加失败' });
  }
});

app.put('/api/todos/:id', authMiddleware, (req, res) => {
  const done = req.body.done ? 1 : 0;
  run('UPDATE todos SET done = ? WHERE id = ? AND user_id = ?', [done, req.params.id, req.userId]);
  res.json({ success: true });
});

app.delete('/api/todos/:id', authMiddleware, (req, res) => {
  run('DELETE FROM todos WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
  res.json({ success: true });
});

// ============================================================
//  统计（个人）
// ============================================================
app.get('/api/stats', authMiddleware, (req, res) => {
  try {
    const checkins = queryAll('SELECT date, hours, note FROM checkins WHERE user_id=? ORDER BY date', [req.userId]);
    const timers = queryAll('SELECT date, seconds, subject FROM timer_sessions WHERE user_id=?', [req.userId]);
    const scores = queryAll('SELECT * FROM exam_scores WHERE user_id=? ORDER BY date', [req.userId]);

    // 连续打卡
    let streak = 0, bestStreak = 0;
    if (checkins.length > 0) {
      let cur = 1; bestStreak = 1;
      const sorted = [...checkins].map(c => c.date).sort();
      for (let i = 1; i < sorted.length; i++) {
        const diff = Math.floor((new Date(sorted[i]) - new Date(sorted[i-1])) / 86400000);
        if (diff === 1) { cur++; bestStreak = Math.max(bestStreak, cur); } else cur = 1;
      }
      const lastDiff = Math.floor((new Date() - new Date(sorted[sorted.length-1])) / 86400000);
      streak = lastDiff <= 1 ? (lastDiff === 0 ? cur : cur) : 0;
      if (lastDiff > 1) streak = 0;
    }

    // 各科时间
    const subjectHours = {};
    timers.forEach(t => {
      const s = t.subject || '其他';
      subjectHours[s] = (subjectHours[s] || 0) + t.seconds / 3600;
    });

    // 成绩趋势
    const scoreBySubject = {};
    scores.forEach(s => {
      if (!scoreBySubject[s.subject]) scoreBySubject[s.subject] = [];
      scoreBySubject[s.subject].push({ date: s.date, score: s.score, total: s.total, exam_name: s.exam_name });
    });

    const totalHours = timers.reduce((s, t) => s + t.seconds, 0) / 3600;

    res.json({
      totalDays: checkins.length,
      totalHours: Math.round(totalHours * 10) / 10,
      streak, bestStreak,
      subjectHours,
      scores: scoreBySubject,
      recentCheckins: checkins.slice(-14)
    });
  } catch (e) {
    res.status(500).json({ error: '获取统计失败' });
  }
});

// ============================================================
//  周报
// ============================================================
app.get('/api/report', authMiddleware, (req, res) => {
  try {
    const now = new Date();
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
    const mondayStr = monday.toISOString().slice(0, 10);
    const todayStr = now.toISOString().slice(0, 10);

    const weeklyCheckins = queryAll('SELECT * FROM checkins WHERE user_id=? AND date>=? AND date<=? ORDER BY date', [req.userId, mondayStr, todayStr]);
    const weeklyTimers = queryAll('SELECT * FROM timer_sessions WHERE user_id=? AND date>=? AND date<=?', [req.userId, mondayStr, todayStr]);
    const weeklyScores = queryAll('SELECT * FROM exam_scores WHERE user_id=? AND date>=? AND date<=?', [req.userId, mondayStr, todayStr]);

    const daysStudied = new Set(weeklyCheckins.map(c => c.date)).size;
    const totalHours = weeklyTimers.reduce((s, t) => s + t.seconds, 0) / 3600;

    // 各科时间
    const subjectTime = {};
    weeklyTimers.forEach(t => {
      const s = t.subject || '其他';
      subjectTime[s] = (subjectTime[s] || 0) + t.seconds / 3600;
    });

    // 心情分布
    const moodCount = {};
    weeklyCheckins.forEach(c => { if (c.mood) moodCount[c.mood] = (moodCount[c.mood] || 0) + 1; });

    res.json({
      week: mondayStr + ' ~ ' + todayStr,
      daysStudied, totalHours: Math.round(totalHours * 10) / 10,
      subjectTime,
      moodCount,
      testCount: weeklyScores.length,
      bestScore: weeklyScores.length > 0 ? Math.max(...weeklyScores.map(s => s.score)) : 0
    });
  } catch (e) {
    res.status(500).json({ error: '生成周报失败' });
  }
});

// ============================================================
//  健康检查 + 前端回退
// ============================================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), users: queryOne('SELECT COUNT(*) as count FROM users').count });
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API 路由不存在' });
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ============================================================
//  启动
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 研友同行云端服务器 v3.1`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`👥 注册用户: ${queryOne('SELECT COUNT(*) as count FROM users').count} 人`);
});
