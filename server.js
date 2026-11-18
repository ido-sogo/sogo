'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { promisify } = require('node:util');
const { createClient } = require('@supabase/supabase-js');

const root = __dirname;
const groups = ['A班', 'B班', 'C班'];
const sessionLifetime = 12 * 60 * 60 * 1000;
const authWindow = 15 * 60 * 1000;
const authLimit = 10;
const scrypt = promisify(crypto.scrypt);
const sessions = new Map();
const authAttempts = new Map();

loadEnvironment();

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const cookieSecure = process.env.COOKIE_SECURE === 'true';
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false }
    })
    : null;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
}
if (!supabase) {
    console.warn('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable database features.');
}
if (!staffPasswordConfigured()) {
    console.warn('Set a STAFF_PASSWORD of at least 16 characters to enable staff registration.');
}

function databaseConfigured() {
    return supabase !== null;
}

function requireDatabase() {
    if (!databaseConfigured()) {
        throw new HttpError(503, 'Supabaseの設定が必要です。.envを設定してサーバーを再起動してください。');
    }
}

async function queryDatabase(query) {
    requireDatabase();
    const { data, error } = await query;
    if (error) {
        throw error;
    }
    return data;
}

async function getGroupNames() {
    const result = await queryDatabase(
        supabase.from('groups').select('name').order('name')
    );
    return result.map((group) => group.name);
}

function staffPasswordConfigured() {
    return typeof process.env.STAFF_PASSWORD === 'string'
        && process.env.STAFF_PASSWORD.length >= 16;
}

class HttpError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
        if (response.headersSent) {
            response.destroy(error);
            return;
        }

        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        if (statusCode >= 500) {
            console.error('Request failed:', error);
        }
        sendJson(response, statusCode, {
            error: statusCode >= 500 ? 'サーバーエラーが発生しました。' : error.message
        });
    });
});

server.listen(port, host, () => {
    console.log(`学校ポータル: http://localhost:${port}`);
    console.log('停止するには Ctrl+C を押してください。');
});

async function handleRequest(request, response) {
    setSecurityHeaders(response);
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
        if (['POST', 'PATCH', 'DELETE'].includes(request.method)) {
            verifyOrigin(request);
        }
        await handleApi(request, response, url);
        return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(405, 'この操作には対応していません。');
    }

    const files = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/index.html': ['index.html', 'text/html; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'],
        '/script.js': ['script.js', 'text/javascript; charset=utf-8']
    };
    const file = files[url.pathname];
    if (!file) {
        throw new HttpError(404, 'ページが見つかりません。');
    }

    fs.readFile(path.join(root, file[0]), (error, content) => {
        if (error) {
            console.error('Failed to read public file:', error);
            sendJson(response, 500, { error: 'ページを読み込めませんでした。' });
            return;
        }
        response.writeHead(200, {
            'Cache-Control': 'no-store',
            'Content-Type': file[1],
            'X-Content-Type-Options': 'nosniff'
        });
        response.end(request.method === 'HEAD' ? undefined : content);
    });
}

async function handleApi(request, response, url) {
    const { method } = request;
    const { pathname } = url;

    if (method === 'GET' && pathname === '/api/config') {
        const groupNames = databaseConfigured() ? await getGroupNames() : groups;
        sendJson(response, 200, {
            groups: groupNames,
            databaseConfigured: databaseConfigured(),
            staffRegistrationEnabled: databaseConfigured() && staffPasswordConfigured()
        });
        return;
    }

    if (method === 'GET' && pathname === '/api/admin/users') {
        await requireStaff(request);
        const users = await queryDatabase(
            supabase.from('users')
                .select('id, username, role, group_name')
                .eq('role', 'member')
                .order('username')
        );
        sendJson(response, 200, { users: users.map(publicUser) });
        return;
    }

    if (method === 'POST' && pathname === '/api/groups') {
        await requireStaff(request);
        const body = await readJson(request);
        const group = await createGroup(body.name);
        sendJson(response, 201, { group });
        return;
    }

    if (method === 'DELETE' && pathname === '/api/groups') {
        await requireStaff(request);
        const body = await readJson(request);
        await deleteGroup(body.name, body.moveTo);
        sendJson(response, 200, { ok: true });
        return;
    }

    const userGroupMatch = pathname.match(/^\/api\/users\/(\d+)\/group$/);
    if (userGroupMatch && method === 'PATCH') {
        await requireStaff(request);
        const body = await readJson(request);
        const user = await assignUserGroup(Number(userGroupMatch[1]), body.groupName);
        sendJson(response, 200, { user });
        return;
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
        const token = sessionToken(request);
        if (token) {
            sessions.delete(token);
        }
        sendJson(response, 200, { ok: true }, [expiredSessionCookie()]);
        return;
    }

    if (method === 'POST' && pathname === '/api/auth/register') {
        checkAuthRate(request);
        await register(request, response);
        return;
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
        checkAuthRate(request);
        await login(request, response);
        return;
    }

    if (method === 'GET' && pathname === '/api/me') {
        sendJson(response, 200, { user: publicUser(await requireUser(request)) });
        return;
    }

    if (method === 'GET' && pathname === '/api/calendar') {
        sendJson(response, 200, await getCalendarData(await requireUser(request)));
        return;
    }

    if (method === 'POST' && pathname === '/api/calendar-items') {
        const user = await requireStaff(request);
        const body = await readJson(request);
        const event = await createCalendarItem(user, body);
        sendJson(response, 201, { event });
        return;
    }

    const completionMatch = pathname.match(/^\/api\/calendar-items\/(\d+)\/completion$/);
    if (completionMatch && method === 'POST') {
        const user = await requireMember(request);
        const body = await readJson(request);
        const update = await saveCompletion(user, Number(completionMatch[1]), body);
        sendJson(response, 200, { update });
        return;
    }
    if (completionMatch && method === 'DELETE') {
        const user = await requireMember(request);
        await deleteCompletion(user, Number(completionMatch[1]));
        sendJson(response, 200, { ok: true });
        return;
    }

    if (method === 'POST' && pathname === '/api/outings') {
        const user = await requireMember(request);
        const body = await readJson(request);
        const outing = await createOuting(user, body);
        sendJson(response, 201, { outing });
        return;
    }

    const outingMatch = pathname.match(/^\/api\/outings\/(\d+)$/);
    if (outingMatch && method === 'DELETE') {
        await deleteOuting(await requireUser(request), Number(outingMatch[1]));
        sendJson(response, 200, { ok: true });
        return;
    }

    const itemMatch = pathname.match(/^\/api\/calendar-items\/(\d+)$/);
    if (itemMatch && method === 'DELETE') {
        await deleteCalendarItem(await requireStaff(request), Number(itemMatch[1]));
        sendJson(response, 200, { ok: true });
        return;
    }

    throw new HttpError(404, 'APIが見つかりません。');
}

async function register(request, response) {
    requireDatabase();
    const body = await readJson(request);
    const username = validateUsername(body.username).toLowerCase();
    const password = validatePassword(body.password);
    let role;
    let groupName;

    if (body.role === 'staff') {
        if (!staffPasswordConfigured()) {
            throw new HttpError(503, '総合係アカウントの登録はまだ設定されていません。');
        }
        if (!secureStringEqual(body.staffPassword, process.env.STAFF_PASSWORD)) {
            throw new HttpError(403, '総合係用パスワードが違います。');
        }
        role = 'staff';
        groupName = null;
    } else {
        const selectedGroupName = validateGroupName(body.group);
        const group = await queryDatabase(
            supabase.from('groups').select('name').eq('name', selectedGroupName).maybeSingle()
        );
        if (!group) {
            throw new HttpError(400, '所属グループを選択してください。');
        }
        role = 'member';
        groupName = group.name;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
    let user;
    try {
        user = await queryDatabase(supabase.from('users').insert({
            username,
            password_salt: salt,
            password_hash: passwordHash,
            role,
            group_name: groupName
        }).select('*').single());
    } catch (error) {
        if (String(error.code) === '23505') {
            throw new HttpError(409, 'このユーザー名はすでに使われています。');
        }
        throw error;
    }

    createSession(user, response);
    sendJson(response, 201, { user: publicUser(user) });
}

async function login(request, response) {
    requireDatabase();
    const body = await readJson(request);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const user = username
        ? await queryDatabase(supabase.from('users').select('*').eq('username', username).maybeSingle())
        : null;

    if (!user || password.length === 0 || password.length > 128) {
        throw new HttpError(401, 'ユーザー名またはパスワードが違います。');
    }

    const actualHash = await scrypt(password, user.password_salt, 64);
    const expectedHash = Buffer.from(user.password_hash, 'hex');
    if (!crypto.timingSafeEqual(actualHash, expectedHash)) {
        throw new HttpError(401, 'ユーザー名またはパスワードが違います。');
    }

    authAttempts.delete(request.socket.remoteAddress || 'unknown');
    createSession(user, response);
    sendJson(response, 200, { user: publicUser(user) });
}

async function getCalendarData(user) {
    let eventQuery = supabase.from('calendar_items').select('*').order('date').order('id');
    let outingQuery = supabase.from('outings').select('*').order('date').order('id');
    if (user.role !== 'staff') {
        eventQuery = eventQuery.or(`type.eq.outing_day,group_name.eq.${user.group_name}`);
        outingQuery = outingQuery.eq('group_name', user.group_name);
    }

    const [items, updates, outingRows] = await Promise.all([
        queryDatabase(eventQuery),
        queryDatabase(supabase.from('completion_updates').select('*').order('updated_at', { ascending: false })),
        queryDatabase(outingQuery)
    ]);
    const userIds = [...new Set([
        ...updates.map((update) => update.user_id),
        ...outingRows.map((outing) => outing.user_id)
    ])];
    const userRows = userIds.length > 0
        ? await queryDatabase(supabase.from('users').select('id, username, group_name').in('id', userIds))
        : [];
    const usersById = new Map(userRows.map((row) => [row.id, row]));
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const visibleUpdates = updates.filter((update) => {
        const updateUser = usersById.get(update.user_id);
        const event = itemsById.get(update.event_id);
        return updateUser && event && (user.role === 'staff' || event.group_name === user.group_name);
    });

    return {
        events: items.map(publicCalendarItem),
        updates: visibleUpdates.map((update) => {
            const updateUser = usersById.get(update.user_id);
            return {
                eventId: update.event_id,
                userId: update.user_id,
                username: updateUser.username,
                groupName: itemsById.get(update.event_id).group_name,
                message: update.message,
                updatedAt: update.updated_at
            };
        }),
        outings: outingRows.map((outing) => ({
            id: outing.id,
            date: outing.date,
            userId: outing.user_id,
            username: usersById.get(outing.user_id).username,
            groupName: outing.group_name,
            description: outing.description
        }))
    };
}

async function createCalendarItem(user, body) {
    const date = validateDate(body.date);
    const type = body.type;
    const title = validateText(body.title, '予定名', 120);
    let groupName = null;

    if (type === 'deadline') {
        const selectedGroupName = validateGroupName(body.groupName);
        const group = await queryDatabase(
            supabase.from('groups').select('name').eq('name', selectedGroupName).maybeSingle()
        );
        if (!group) {
            throw new HttpError(400, '提出期限の対象グループを選択してください。');
        }
        groupName = group.name;
    } else if (type !== 'outing_day') {
        throw new HttpError(400, '予定の種類が正しくありません。');
    }

    const item = await queryDatabase(supabase.from('calendar_items').insert({
        date,
        type,
        group_name: groupName,
        title,
        created_by: user.id
    }).select('*').single());
    return publicCalendarItem(item);
}

async function createGroup(value) {
    const name = validateGroupName(value);
    try {
        return await queryDatabase(
            supabase.from('groups').insert({ name }).select('name').single()
        );
    } catch (error) {
        if (String(error.code) === '23505') {
            throw new HttpError(409, '同じ名前のグループがすでにあります。');
        }
        throw error;
    }
}

async function deleteGroup(sourceValue, targetValue) {
    const sourceName = validateGroupName(sourceValue);
    const targetName = validateGroupName(targetValue);
    if (sourceName === targetName) {
        throw new HttpError(400, '移動先には別のグループを選択してください。');
    }

    try {
        await queryDatabase(supabase.rpc('move_group_and_delete', {
            p_source_name: sourceName,
            p_target_name: targetName
        }));
    } catch (error) {
        if (String(error.code) === 'P0002') {
            throw new HttpError(404, '削除元または移動先のグループが見つかりません。');
        }
        if (String(error.code) === '22023') {
            throw new HttpError(400, '別のグループを移動先に選択してください。');
        }
        throw error;
    }
}

async function assignUserGroup(userId, value) {
    const groupName = validateGroupName(value);
    const group = await queryDatabase(
        supabase.from('groups').select('name').eq('name', groupName).maybeSingle()
    );
    if (!group) {
        throw new HttpError(400, '所属先のグループを選択してください。');
    }
    const target = await queryDatabase(
        supabase.from('users').select('id, role').eq('id', userId).maybeSingle()
    );
    if (!target || target.role !== 'member') {
        throw new HttpError(404, '一般利用者が見つかりません。');
    }
    const updatedUser = await queryDatabase(
        supabase.from('users')
            .update({ group_name: group.name })
            .eq('id', userId)
            .eq('role', 'member')
            .select('id, username, role, group_name')
            .single()
    );
    return publicUser(updatedUser);
}

async function saveCompletion(user, eventId, body) {
    const event = await queryDatabase(
        supabase.from('calendar_items').select('*').eq('id', eventId).maybeSingle()
    );
    if (!event || event.type !== 'deadline' || event.group_name !== user.group_name) {
        throw new HttpError(404, 'このグループの提出予定が見つかりません。');
    }
    const message = body.message === undefined || body.message === ''
        ? '完了しました'
        : validateText(body.message, '完了報告', 300);
    await queryDatabase(supabase.from('completion_updates').upsert({
        event_id: eventId,
        user_id: user.id,
        message,
        updated_at: new Date().toISOString()
    }, { onConflict: 'event_id,user_id' }));
    return { eventId, userId: user.id, username: user.username, message };
}

async function deleteCompletion(user, eventId) {
    const event = await queryDatabase(
        supabase.from('calendar_items').select('*').eq('id', eventId).maybeSingle()
    );
    if (!event || event.type !== 'deadline' || event.group_name !== user.group_name) {
        throw new HttpError(404, 'このグループの提出予定が見つかりません。');
    }
    await queryDatabase(
        supabase.from('completion_updates').delete().eq('event_id', eventId).eq('user_id', user.id)
    );
}

async function createOuting(user, body) {
    const date = validateDate(body.date);
    if (date < localDateString()) {
        throw new HttpError(400, '過去の日付には外出予定を作成できません。');
    }
    const availableDay = await queryDatabase(
        supabase.from('calendar_items')
            .select('id')
            .eq('type', 'outing_day')
            .eq('date', date)
            .limit(1)
            .maybeSingle()
    );
    if (!availableDay) {
        throw new HttpError(400, '総合係が設定した外出可能日を選んでください。');
    }
    const description = validateText(body.description, '外出予定', 300);
    const outing = await queryDatabase(supabase.from('outings').insert({
        date,
        user_id: user.id,
        group_name: user.group_name,
        description
    }).select('id').single());
    return {
        id: outing.id,
        date,
        userId: user.id,
        username: user.username,
        groupName: user.group_name,
        description
    };
}

async function deleteOuting(user, outingId) {
    const outing = await queryDatabase(
        supabase.from('outings').select('user_id').eq('id', outingId).maybeSingle()
    );
    if (!outing) {
        throw new HttpError(404, '外出予定が見つかりません。');
    }
    if (user.role !== 'staff' && outing.user_id !== user.id) {
        throw new HttpError(403, '自分の外出予定だけ削除できます。');
    }
    await queryDatabase(supabase.from('outings').delete().eq('id', outingId));
}

async function deleteCalendarItem(user, eventId) {
    const event = await queryDatabase(
        supabase.from('calendar_items').select('*').eq('id', eventId).maybeSingle()
    );
    if (!event) {
        throw new HttpError(404, '予定が見つかりません。');
    }
    if (event.type === 'outing_day') {
        const outings = await queryDatabase(
            supabase.from('outings').select('id').eq('date', event.date).limit(1)
        );
        if (outings.length > 0) {
            throw new HttpError(409, 'この日に外出予定があるため、先に外出予定を削除してください。');
        }
    }
    await queryDatabase(supabase.from('calendar_items').delete().eq('id', eventId));
}

async function requireUser(request) {
    requireDatabase();
    const token = sessionToken(request);
    const session = token && sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
        if (token) {
            sessions.delete(token);
        }
        throw new HttpError(401, 'ログインしてください。');
    }
    const user = await queryDatabase(supabase.from('users').select('*').eq('id', session.userId).maybeSingle());
    if (!user) {
        sessions.delete(token);
        throw new HttpError(401, 'ログインし直してください。');
    }
    return user;
}

async function requireMember(request) {
    const user = await requireUser(request);
    if (user.role !== 'member') {
        throw new HttpError(403, '一般利用者のみ操作できます。');
    }
    return user;
}

async function requireStaff(request) {
    const user = await requireUser(request);
    if (user.role !== 'staff') {
        throw new HttpError(403, '総合係のみ操作できます。');
    }
    return user;
}

function createSession(user, response) {
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + sessionLifetime });
    const secure = cookieSecure ? '; Secure' : '';
    response.setHeader(
        'Set-Cookie',
        `school_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetime / 1000}${secure}`
    );
}

function sessionToken(request) {
    const cookieHeader = request.headers.cookie || '';
    const cookie = cookieHeader.split(';').map((part) => part.trim())
        .find((part) => part.startsWith('school_session='));
    return cookie ? cookie.slice('school_session='.length) : null;
}

function expiredSessionCookie() {
    return 'school_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';
}

function publicUser(user) {
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        group: user.group_name
    };
}

function publicCalendarItem(item) {
    return {
        id: item.id,
        date: item.date,
        type: item.type,
        groupName: item.group_name,
        title: item.title
    };
}

function validateUsername(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{3,32}$/.test(value)) {
        throw new HttpError(400, 'ユーザー名は半角英数字、. _ - の3〜32文字で入力してください。');
    }
    return value;
}

function validatePassword(value) {
    if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
        throw new HttpError(400, 'パスワードは10〜128文字で設定してください。');
    }
    return value;
}

function validateDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new HttpError(400, '日付を正しく入力してください。');
    }
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new HttpError(400, '日付を正しく入力してください。');
    }
    return value;
}

function validateText(value, label, maxLength) {
    if (typeof value !== 'string') {
        throw new HttpError(400, `${label}を入力してください。`);
    }
    const text = value.trim();
    if (text.length === 0 || text.length > maxLength) {
        throw new HttpError(400, `${label}は1〜${maxLength}文字で入力してください。`);
    }
    return text;
}

function validateGroupName(value) {
    const name = validateText(value, 'グループ名', 30);
    if (!/^[\p{L}\p{N}_-]+$/u.test(name)) {
        throw new HttpError(400, 'グループ名は日本語・英数字・_-で入力してください。');
    }
    return name;
}

async function readJson(request) {
    if (!String(request.headers['content-type'] || '').includes('application/json')) {
        throw new HttpError(415, 'JSON形式で送信してください。');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 32_768) {
            throw new HttpError(413, '送信データが大きすぎます。');
        }
        chunks.push(chunk);
    }
    try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            throw new Error('JSON body must be an object.');
        }
        return body;
    } catch {
        throw new HttpError(400, '送信データの形式が正しくありません。');
    }
}

function checkAuthRate(request) {
    const address = request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempts = (authAttempts.get(address) || []).filter((time) => now - time < authWindow);
    if (attempts.length >= authLimit) {
        throw new HttpError(429, '試行回数が多すぎます。しばらくしてから再試行してください。');
    }
    attempts.push(now);
    authAttempts.set(address, attempts);
}

function secureStringEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') {
        return false;
    }
    const leftHash = crypto.createHash('sha256').update(left).digest();
    const rightHash = crypto.createHash('sha256').update(right).digest();
    return crypto.timingSafeEqual(leftHash, rightHash);
}

function verifyOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) {
        return;
    }
    let originUrl;
    try {
        originUrl = new URL(origin);
    } catch {
        throw new HttpError(403, '送信元を確認できません。');
    }
    if (originUrl.host !== request.headers.host) {
        throw new HttpError(403, '送信元が正しくありません。');
    }
}

function localDateString() {
    const date = new Date();
    return [
        date.getFullYear(),
        String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')
    ].join('-');
}

function loadEnvironment() {
    const filePath = path.join(__dirname, '.env');
    if (!fs.existsSync(filePath)) {
        return;
    }
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || match[1] in process.env) {
            continue;
        }
        let value = match[2];
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        process.env[match[1]] = value;
    }
}

function setSecurityHeaders(response) {
    response.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'"
    ].join('; '));
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
}

function sendJson(response, statusCode, value, extraCookies = []) {
    const headers = {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8'
    };
    if (extraCookies.length > 0) {
        headers['Set-Cookie'] = extraCookies;
    } else if (response.getHeader('Set-Cookie')) {
        headers['Set-Cookie'] = response.getHeader('Set-Cookie');
    }
    response.writeHead(statusCode, headers);
    response.end(JSON.stringify(value));
}
