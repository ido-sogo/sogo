import { createClient } from "@supabase/supabase-js";
import scryptJs from "scrypt-js";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const staffPassword = Deno.env.get("STAFF_PASSWORD");

if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase function secrets are not configured.");
}

const allowedOrigins = new Set([
    new URL(supabaseUrl).origin,
    "https://ido-sogo.github.io",
]);
const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
});
const cookieName = "school_session";
const sessionLifetimeSeconds = 12 * 60 * 60;
const authWindowSeconds = 15 * 60;
const authLimit = 10;

interface AppUser {
    id: number;
    username: string;
    password_salt: string;
    password_hash: string;
    role: "member" | "staff";
    group_name: string | null;
}

interface CalendarItem {
    id: number;
    date: string;
    type: "outing_day" | "deadline";
    group_name: string | null;
    title: string;
    created_by: number;
}

interface AuthSession {
    token_hash: string;
    user_id: number;
    expires_at: string;
}

class HttpError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

Deno.serve(async (request) => {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: responseHeaders(request) });
    }

    try {
        if (["POST", "PATCH", "DELETE"].includes(request.method)) {
            verifyOrigin(request);
        }
        return await handleApi(request, url);
    } catch (error) {
        const statusCode = error instanceof HttpError ? error.statusCode : 500;
        if (statusCode >= 500) {
            console.error("Request failed:", error);
        }
        return sendJson(request, statusCode, {
            error: error instanceof HttpError ? error.message : "サーバーエラーが発生しました。",
        });
    }
});

async function handleApi(request: Request, url: URL): Promise<Response> {
    const method = request.method;
    const pathname = apiPath(url.pathname);

    if (method === "GET" && pathname === "/api/config") {
        const groupNames = await getGroupNames();
        return sendJson(request, 200, {
            groups: groupNames,
            databaseConfigured: true,
            staffRegistrationEnabled: typeof staffPassword === "string" && staffPassword.length >= 16,
        });
    }

    if (method === "GET" && pathname === "/api/admin/users") {
        await requireStaff(request);
        const users = await queryDatabase<Array<Pick<AppUser, "id" | "username" | "role" | "group_name">>>(
            supabase.from("users")
                .select("id, username, role, group_name")
                .eq("role", "member")
                .order("username"),
        );
        return sendJson(request, 200, { users: users.map(publicUser) });
    }

    if (method === "POST" && pathname === "/api/groups") {
        await requireStaff(request);
        const body = await readJson(request);
        const group = await createGroup(body.name);
        return sendJson(request, 201, { group });
    }

    if (method === "DELETE" && pathname === "/api/groups") {
        await requireStaff(request);
        const body = await readJson(request);
        await deleteGroup(body.name, body.moveTo);
        return sendJson(request, 200, { ok: true });
    }

    const userGroupMatch = pathname.match(/^\/api\/users\/(\d+)\/group$/);
    if (userGroupMatch && method === "PATCH") {
        await requireStaff(request);
        const body = await readJson(request);
        const user = await assignUserGroup(Number(userGroupMatch[1]), body.groupName);
        return sendJson(request, 200, { user });
    }

    if (method === "POST" && pathname === "/api/auth/logout") {
        const token = sessionToken(request);
        if (token) {
            await executeDatabase(
                supabase.from("auth_sessions").delete().eq("token_hash", await sha256Hex(token)),
            );
        }
        return sendJson(request, 200, { ok: true }, expiredSessionCookie());
    }

    if (method === "POST" && pathname === "/api/auth/register") {
        const ipHash = await checkAuthRate(request);
        return await register(request, ipHash);
    }

    if (method === "POST" && pathname === "/api/auth/login") {
        const ipHash = await checkAuthRate(request);
        return await login(request, ipHash);
    }

    if (method === "GET" && pathname === "/api/me") {
        return sendJson(request, 200, { user: publicUser(await requireUser(request)) });
    }

    if (method === "GET" && pathname === "/api/calendar") {
        return sendJson(request, 200, await getCalendarData(await requireUser(request)));
    }

    if (method === "POST" && pathname === "/api/calendar-items") {
        const user = await requireStaff(request);
        const body = await readJson(request);
        const event = await createCalendarItem(user, body);
        return sendJson(request, 201, { event });
    }

    const completionMatch = pathname.match(/^\/api\/calendar-items\/(\d+)\/completion$/);
    if (completionMatch && method === "POST") {
        const user = await requireMember(request);
        const body = await readJson(request);
        const update = await saveCompletion(user, Number(completionMatch[1]), body);
        return sendJson(request, 200, { update });
    }
    if (completionMatch && method === "DELETE") {
        const user = await requireMember(request);
        await deleteCompletion(user, Number(completionMatch[1]));
        return sendJson(request, 200, { ok: true });
    }

    if (method === "POST" && pathname === "/api/outings") {
        const user = await requireMember(request);
        const body = await readJson(request);
        const outing = await createOuting(user, body);
        return sendJson(request, 201, { outing });
    }

    const outingMatch = pathname.match(/^\/api\/outings\/(\d+)$/);
    if (outingMatch && method === "PATCH") {
        await requireStaff(request);
        const body = await readJson(request);
        await updateOuting(Number(outingMatch[1]), body);
        return sendJson(request, 200, { ok: true });
    }
    if (outingMatch && method === "DELETE") {
        await deleteOuting(await requireUser(request), Number(outingMatch[1]));
        return sendJson(request, 200, { ok: true });
    }

    const itemMatch = pathname.match(/^\/api\/calendar-items\/(\d+)$/);
    if (itemMatch && method === "PATCH") {
        await requireStaff(request);
        const body = await readJson(request);
        const event = await updateCalendarItem(Number(itemMatch[1]), body);
        return sendJson(request, 200, { event });
    }
    if (itemMatch && method === "DELETE") {
        await deleteCalendarItem(await requireStaff(request), Number(itemMatch[1]));
        return sendJson(request, 200, { ok: true });
    }

    throw new HttpError(404, "APIが見つかりません。");
}

async function register(request: Request, ipHash: string): Promise<Response> {
    const body = await readJson(request);
    const username = validateUsername(body.username).toLowerCase();
    const password = validatePassword(body.password);
    let role: AppUser["role"];
    let groupName: string | null;

    if (body.role === "staff") {
        if (typeof staffPassword !== "string" || staffPassword.length < 16) {
            throw new HttpError(503, "総合係アカウントの登録はまだ設定されていません。");
        }
        if (!await secureStringEqual(body.staffPassword, staffPassword)) {
            throw new HttpError(403, "総合係用パスワードが違います。");
        }
        role = "staff";
        groupName = null;
    } else {
        const selectedGroupName = validateGroupName(body.group);
        const group = await queryMaybeSingle<{ name: string }>(
            supabase.from("groups")
                .select("name")
                .eq("name", selectedGroupName)
                .maybeSingle(),
        );
        if (!group) {
            throw new HttpError(400, "所属グループを選択してください。");
        }
        role = "member";
        groupName = group.name;
    }

    const salt = randomHex(16);
    const passwordHash = bytesToHex(await hashPassword(password, salt));
    let user: AppUser;
    try {
        user = await queryDatabase<AppUser>(
            supabase.from("users").insert({
                username,
                password_salt: salt,
                password_hash: passwordHash,
                role,
                group_name: groupName,
            }).select("*").single(),
        );
    } catch (error) {
        if (errorCode(error) === "23505") {
            throw new HttpError(409, "このユーザー名はすでに使われています。");
        }
        throw error;
    }

    await clearAuthAttempts(ipHash);
    const cookie = await createSession(user);
    return sendJson(request, 201, { user: publicUser(user) }, cookie);
}

async function login(request: Request, ipHash: string): Promise<Response> {
    const body = await readJson(request);
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const user = username
        ? await queryMaybeSingle<AppUser>(
            supabase.from("users").select("*").eq("username", username).maybeSingle(),
        )
        : null;

    if (!user || password.length === 0 || password.length > 128) {
        throw new HttpError(401, "ユーザー名またはパスワードが違います。");
    }

    const actualHash = await hashPassword(password, user.password_salt);
    if (!constantTimeEqual(actualHash, hexToBytes(user.password_hash))) {
        throw new HttpError(401, "ユーザー名またはパスワードが違います。");
    }

    await clearAuthAttempts(ipHash);
    const cookie = await createSession(user);
    return sendJson(request, 200, { user: publicUser(user) }, cookie);
}

async function getCalendarData(user: AppUser) {
    let eventQuery = supabase.from("calendar_items").select("*").order("date").order("id");
    let outingQuery = supabase.from("outings").select("*").order("date").order("id");
    if (user.role !== "staff") {
        eventQuery = eventQuery.or(`type.eq.outing_day,group_name.eq.${user.group_name}`);
        outingQuery = outingQuery.eq("group_name", user.group_name);
    }

    const [items, updates, outingRows] = await Promise.all([
        queryDatabase<CalendarItem[]>(eventQuery),
        queryDatabase<Array<{
            event_id: number;
            user_id: number;
            message: string;
            updated_at: string;
        }>>(supabase.from("completion_updates").select("*").order("updated_at", { ascending: false })),
        queryDatabase<Array<{
            id: number;
            date: string;
            user_id: number;
            group_name: string;
            description: string;
            created_at: string;
        }>>(outingQuery),
    ]);

    const userIds = [...new Set([
        ...updates.map((update) => update.user_id),
        ...outingRows.map((outing) => outing.user_id),
    ])];
    const userRows = userIds.length > 0
        ? await queryDatabase<Array<Pick<AppUser, "id" | "username" | "group_name">>>(
            supabase.from("users").select("id, username, group_name").in("id", userIds),
        )
        : [];
    const usersById = new Map(userRows.map((row) => [row.id, row]));
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const visibleUpdates = updates.filter((update) => {
        const updateUser = usersById.get(update.user_id);
        const event = itemsById.get(update.event_id);
        return updateUser && event && (user.role === "staff" || event.group_name === user.group_name);
    });

    return {
        events: items.map(publicCalendarItem),
        updates: visibleUpdates.map((update) => {
            const updateUser = usersById.get(update.user_id)!;
            const event = itemsById.get(update.event_id)!;
            return {
                eventId: update.event_id,
                userId: update.user_id,
                username: updateUser.username,
                groupName: event.group_name,
                message: update.message,
                updatedAt: update.updated_at,
            };
        }),
        outings: outingRows.map((outing) => ({
            id: outing.id,
            date: outing.date,
            userId: outing.user_id,
            username: usersById.get(outing.user_id)!.username,
            groupName: outing.group_name,
            description: outing.description,
            createdAt: outing.created_at,
        })),
    };
}

async function createCalendarItem(user: AppUser, body: Record<string, unknown>) {
    const date = validateDate(body.date);
    const type = body.type;
    const title = validateText(body.title, "予定名", 120);
    let groupName: string | null = null;

    if (type === "deadline") {
        const selectedGroupName = validateGroupName(body.groupName);
        const group = await queryMaybeSingle<{ name: string }>(
            supabase.from("groups")
                .select("name")
                .eq("name", selectedGroupName)
                .maybeSingle(),
        );
        if (!group) {
            throw new HttpError(400, "提出期限の対象グループを選択してください。");
        }
        groupName = group.name;
    } else if (type !== "outing_day") {
        throw new HttpError(400, "予定の種類が正しくありません。");
    }

    const item = await queryDatabase<CalendarItem>(
        supabase.from("calendar_items").insert({
            date,
            type,
            group_name: groupName,
            title,
            created_by: user.id,
        }).select("*").single(),
    );
    return publicCalendarItem(item);
}

async function updateCalendarItem(eventId: number, body: Record<string, unknown>) {
    const current = await queryMaybeSingle<CalendarItem>(
        supabase.from("calendar_items").select("*").eq("id", eventId).maybeSingle(),
    );
    if (!current) {
        throw new HttpError(404, "予定が見つかりません。");
    }

    const date = validateDate(body.date);
    const title = validateText(body.title, "予定名", 120);
    let groupName: string | null = null;
    if (current.type === "deadline") {
        const selectedGroupName = validateGroupName(body.groupName);
        const group = await queryMaybeSingle<{ name: string }>(
            supabase.from("groups").select("name").eq("name", selectedGroupName).maybeSingle(),
        );
        if (!group) {
            throw new HttpError(400, "提出期限の対象グループを選択してください。");
        }
        groupName = group.name;
    }

    if (current.type === "outing_day" && date !== current.date) {
        const outings = await queryDatabase<Array<{ id: number }>>(
            supabase.from("outings").select("id").eq("date", current.date).limit(1),
        );
        if (outings.length > 0) {
            throw new HttpError(409, "この日に外出予定があるため、先に外出予定を変更または削除してください。");
        }
    }

    const updated = await queryDatabase<CalendarItem>(
        supabase.from("calendar_items")
            .update({ date, group_name: groupName, title })
            .eq("id", eventId)
            .select("*")
            .single(),
    );
    return publicCalendarItem(updated);
}

async function createGroup(value: unknown) {
    const name = validateGroupName(value);
    try {
        return await queryDatabase<{ name: string }>(
            supabase.from("groups").insert({ name }).select("name").single(),
        );
    } catch (error) {
        if (errorCode(error) === "23505") {
            throw new HttpError(409, "同じ名前のグループがすでにあります。");
        }
        throw error;
    }
}

async function deleteGroup(sourceValue: unknown, targetValue: unknown): Promise<void> {
    const sourceName = validateGroupName(sourceValue);
    const targetName = validateGroupName(targetValue);
    if (sourceName === targetName) {
        throw new HttpError(400, "移動先には別のグループを選択してください。");
    }

    try {
        await executeDatabase(
            supabase.rpc("move_group_and_delete", {
                p_source_name: sourceName,
                p_target_name: targetName,
            }),
        );
    } catch (error) {
        if (errorCode(error) === "P0002") {
            throw new HttpError(404, "削除元または移動先のグループが見つかりません。");
        }
        if (errorCode(error) === "22023") {
            throw new HttpError(400, "別のグループを移動先に選択してください。");
        }
        throw error;
    }
}

async function assignUserGroup(userId: number, value: unknown) {
    const groupName = validateGroupName(value);
    const group = await queryMaybeSingle<{ name: string }>(
        supabase.from("groups").select("name").eq("name", groupName).maybeSingle(),
    );
    if (!group) {
        throw new HttpError(400, "所属先のグループを選択してください。");
    }
    const target = await queryMaybeSingle<Pick<AppUser, "id" | "role">>(
        supabase.from("users").select("id, role").eq("id", userId).maybeSingle(),
    );
    if (!target || target.role !== "member") {
        throw new HttpError(404, "一般利用者が見つかりません。");
    }
    const updatedUser = await queryDatabase<Pick<AppUser, "id" | "username" | "role" | "group_name">>(
        supabase.from("users")
            .update({ group_name: group.name })
            .eq("id", userId)
            .eq("role", "member")
            .select("id, username, role, group_name")
            .single(),
    );
    return publicUser(updatedUser);
}

async function saveCompletion(user: AppUser, eventId: number, body: Record<string, unknown>) {
    const event = await queryMaybeSingle<CalendarItem>(
        supabase.from("calendar_items").select("*").eq("id", eventId).maybeSingle(),
    );
    if (!event || event.type !== "deadline" || event.group_name !== user.group_name) {
        throw new HttpError(404, "このグループの提出予定が見つかりません。");
    }
    const message = body.message === undefined || body.message === ""
        ? "完了しました"
        : validateText(body.message, "完了報告", 300);
    await executeDatabase(
        supabase.from("completion_updates").upsert({
            event_id: eventId,
            user_id: user.id,
            message,
            updated_at: new Date().toISOString(),
        }, { onConflict: "event_id,user_id" }),
    );
    return { eventId, userId: user.id, username: user.username, message };
}

async function deleteCompletion(user: AppUser, eventId: number): Promise<void> {
    const event = await queryMaybeSingle<CalendarItem>(
        supabase.from("calendar_items").select("*").eq("id", eventId).maybeSingle(),
    );
    if (!event || event.type !== "deadline" || event.group_name !== user.group_name) {
        throw new HttpError(404, "このグループの提出予定が見つかりません。");
    }
    await executeDatabase(
        supabase.from("completion_updates").delete().eq("event_id", eventId).eq("user_id", user.id),
    );
}

async function createOuting(user: AppUser, body: Record<string, unknown>) {
    if (!user.group_name) {
        throw new HttpError(403, "一般利用者の所属グループが設定されていません。");
    }
    const date = validateDate(body.date);
    if (date < localDateString()) {
        throw new HttpError(400, "過去の日付には外出予定を作成できません。");
    }
    const availableDay = await queryMaybeSingle<{ id: number }>(
        supabase.from("calendar_items")
            .select("id")
            .eq("type", "outing_day")
            .eq("date", date)
            .limit(1)
            .maybeSingle(),
    );
    if (!availableDay) {
        throw new HttpError(400, "総合係が設定した外出可能日を選んでください。");
    }
    const description = validateText(body.description, "外出予定", 300);
    const outing = await queryDatabase<{ id: number; created_at: string }>(
        supabase.from("outings").insert({
            date,
            user_id: user.id,
            group_name: user.group_name,
            description,
        }).select("id, created_at").single(),
    );
    return {
        id: outing.id,
        date,
        userId: user.id,
        username: user.username,
        groupName: user.group_name,
        description,
        createdAt: outing.created_at,
    };
}

async function updateOuting(outingId: number, body: Record<string, unknown>): Promise<void> {
    const current = await queryMaybeSingle<{ id: number }>(
        supabase.from("outings").select("id").eq("id", outingId).maybeSingle(),
    );
    if (!current) {
        throw new HttpError(404, "外出予定が見つかりません。");
    }

    const date = validateDate(body.date);
    if (date < localDateString()) {
        throw new HttpError(400, "過去の日付には外出予定を変更できません。");
    }
    const availableDay = await queryMaybeSingle<{ id: number }>(
        supabase.from("calendar_items").select("id")
            .eq("type", "outing_day").eq("date", date).limit(1).maybeSingle(),
    );
    if (!availableDay) {
        throw new HttpError(400, "総合係が設定した外出可能日を選んでください。");
    }

    const description = validateText(body.description, "外出予定", 300);
    await executeDatabase(
        supabase.from("outings").update({ date, description }).eq("id", outingId),
    );
}

async function deleteOuting(user: AppUser, outingId: number): Promise<void> {
    const outing = await queryMaybeSingle<{
        group_name: string;
        created_at: string;
    }>(
        supabase.from("outings").select("group_name, created_at")
            .eq("id", outingId).maybeSingle(),
    );
    if (!outing) {
        throw new HttpError(404, "外出予定が見つかりません。");
    }
    if (user.role !== "staff") {
        if (outing.group_name !== user.group_name) {
            throw new HttpError(403, "自分のグループの外出予定だけ削除できます。");
        }
        const age = Date.now() - Date.parse(outing.created_at);
        if (!Number.isFinite(age) || age < 0 || age > 30 * 60 * 1000) {
            throw new HttpError(403, "投稿から30分を過ぎた外出予定は削除できません。総合係に依頼してください。");
        }
    }
    await executeDatabase(supabase.from("outings").delete().eq("id", outingId));
}

async function deleteCalendarItem(user: AppUser, eventId: number): Promise<void> {
    const event = await queryMaybeSingle<CalendarItem>(
        supabase.from("calendar_items").select("*").eq("id", eventId).maybeSingle(),
    );
    if (!event) {
        throw new HttpError(404, "予定が見つかりません。");
    }
    if (event.type === "outing_day") {
        const outings = await queryDatabase<Array<{ id: number }>>(
            supabase.from("outings").select("id").eq("date", event.date).limit(1),
        );
        if (outings.length > 0) {
            throw new HttpError(409, "この日に外出予定があるため、先に外出予定を削除してください。");
        }
    }
    await executeDatabase(supabase.from("calendar_items").delete().eq("id", eventId));
}

async function requireUser(request: Request): Promise<AppUser> {
    const token = sessionToken(request);
    if (!token) {
        throw new HttpError(401, "ログインしてください。");
    }
    const tokenHash = await sha256Hex(token);
    const session = await queryMaybeSingle<AuthSession>(
        supabase.from("auth_sessions")
            .select("token_hash, user_id, expires_at")
            .eq("token_hash", tokenHash)
            .gt("expires_at", new Date().toISOString())
            .maybeSingle(),
    );
    if (!session) {
        throw new HttpError(401, "ログインし直してください。");
    }
    const user = await queryMaybeSingle<AppUser>(
        supabase.from("users").select("*").eq("id", session.user_id).maybeSingle(),
    );
    if (!user) {
        await executeDatabase(
            supabase.from("auth_sessions").delete().eq("token_hash", tokenHash),
        );
        throw new HttpError(401, "ログインし直してください。");
    }
    return user;
}

async function requireMember(request: Request): Promise<AppUser> {
    const user = await requireUser(request);
    if (user.role !== "member") {
        throw new HttpError(403, "一般利用者のみ操作できます。");
    }
    return user;
}

async function requireStaff(request: Request): Promise<AppUser> {
    const user = await requireUser(request);
    if (user.role !== "staff") {
        throw new HttpError(403, "総合係のみ操作できます。");
    }
    return user;
}

async function createSession(user: AppUser): Promise<string> {
    const tokenBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenBytes);
    const token = bytesToBase64Url(tokenBytes);
    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(Date.now() + sessionLifetimeSeconds * 1000).toISOString();
    await executeDatabase(
        supabase.from("auth_sessions").delete().lt("expires_at", new Date().toISOString()),
    );
    await executeDatabase(
        supabase.from("auth_sessions").insert({
            token_hash: tokenHash,
            user_id: user.id,
            expires_at: expiresAt,
        }),
    );
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=${sessionLifetimeSeconds}`;
}

function sessionToken(request: Request): string | null {
    const cookieHeader = request.headers.get("cookie") ?? "";
    const cookie = cookieHeader.split(";").map((part) => part.trim())
        .find((part) => part.startsWith(`${cookieName}=`));
    return cookie ? cookie.slice(cookieName.length + 1) : null;
}

function expiredSessionCookie(): string {
    return `${cookieName}=; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0`;
}

function publicUser(user: Pick<AppUser, "id" | "username" | "role" | "group_name">) {
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        group: user.group_name,
    };
}

function publicCalendarItem(item: CalendarItem) {
    return {
        id: item.id,
        date: item.date,
        type: item.type,
        groupName: item.group_name,
        title: item.title,
    };
}

function validateUsername(value: unknown): string {
    if (typeof value !== "string" || !/^[A-Za-z0-9._-]{3,32}$/.test(value)) {
        throw new HttpError(400, "ユーザー名は半角英数字、. _ - の3〜32文字で入力してください。");
    }
    return value;
}

function validatePassword(value: unknown): string {
    if (typeof value !== "string" || value.length < 10 || value.length > 128) {
        throw new HttpError(400, "パスワードは10〜128文字で設定してください。");
    }
    return value;
}

function validateDate(value: unknown): string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new HttpError(400, "日付を正しく入力してください。");
    }
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
        throw new HttpError(400, "日付を正しく入力してください。");
    }
    return value;
}

function validateText(value: unknown, label: string, maxLength: number): string {
    if (typeof value !== "string") {
        throw new HttpError(400, `${label}を入力してください。`);
    }
    const text = value.trim();
    if (text.length === 0 || text.length > maxLength) {
        throw new HttpError(400, `${label}は1〜${maxLength}文字で入力してください。`);
    }
    return text;
}

function validateGroupName(value: unknown): string {
    const name = validateText(value, "グループ名", 30);
    if (!/^[\p{L}\p{N}_-]+$/u.test(name)) {
        throw new HttpError(400, "グループ名は日本語・英数字・_-で入力してください。");
    }
    return name;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
    if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
        throw new HttpError(415, "JSON形式で送信してください。");
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 32_768) {
        throw new HttpError(413, "送信データが大きすぎます。");
    }
    try {
        const body: unknown = JSON.parse(text);
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
            throw new Error("JSON body must be an object.");
        }
        return body as Record<string, unknown>;
    } catch {
        throw new HttpError(400, "送信データの形式が正しくありません。");
    }
}

async function checkAuthRate(request: Request): Promise<string> {
    const forwarded = request.headers.get("cf-connecting-ip")
        ?? request.headers.get("x-real-ip")
        ?? request.headers.get("x-forwarded-for")?.split(",")[0].trim()
        ?? "unknown";
    const ipHash = await sha256Hex(forwarded);
    const allowed = await queryDatabase<boolean>(
        supabase.rpc("consume_auth_attempt", {
            p_ip_hash: ipHash,
            p_window_seconds: authWindowSeconds,
            p_max_attempts: authLimit,
        }),
    );
    if (!allowed) {
        throw new HttpError(429, "試行回数が多すぎます。しばらくしてから再試行してください。");
    }
    return ipHash;
}

async function clearAuthAttempts(ipHash: string): Promise<void> {
    await executeDatabase(
        supabase.rpc("clear_auth_attempts", { p_ip_hash: ipHash }),
    );
}

async function secureStringEqual(left: unknown, right: string): Promise<boolean> {
    if (typeof left !== "string") {
        return false;
    }
    return constantTimeEqual(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
    );
}

function verifyOrigin(request: Request): void {
    const origin = request.headers.get("origin");
    if (!origin) {
        return;
    }
    let originUrl: URL;
    try {
        originUrl = new URL(origin);
    } catch {
        throw new HttpError(403, "送信元を確認できません。");
    }
    if (!allowedOrigins.has(originUrl.origin)) {
        throw new HttpError(403, "送信元が正しくありません。");
    }
}

function localDateString(): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());
    const valueFor = (type: string): string => {
        const value = parts.find((part) => part.type === type)?.value;
        if (!value) {
            throw new Error("Could not format the current date.");
        }
        return value;
    };
    return `${valueFor("year")}-${valueFor("month")}-${valueFor("day")}`;
}

async function getGroupNames(): Promise<string[]> {
    const groups = await queryDatabase<Array<{ name: string }>>(
        supabase.from("groups").select("name").order("name"),
    );
    return groups.map((group) => group.name);
}

async function hashPassword(password: string, salt: string): Promise<Uint8Array> {
    return await scryptJs.scrypt(
        new TextEncoder().encode(password),
        new TextEncoder().encode(salt),
        16_384,
        8,
        1,
        64,
    );
}

async function sha256Hex(value: string): Promise<string> {
    return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function randomHex(length: number): string {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
    const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    return Array.from(view)
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
}

function hexToBytes(value: string): Uint8Array {
    if (!/^(?:[0-9a-f]{2})+$/i.test(value)) {
        return new Uint8Array(0);
    }
    return Uint8Array.from(value.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
}

function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function constantTimeEqual(left: ArrayBuffer | Uint8Array, right: ArrayBuffer | Uint8Array): boolean {
    const leftBytes = left instanceof ArrayBuffer ? new Uint8Array(left) : left;
    const rightBytes = right instanceof ArrayBuffer ? new Uint8Array(right) : right;
    let difference = leftBytes.length ^ rightBytes.length;
    const maxLength = Math.max(leftBytes.length, rightBytes.length);
    for (let index = 0; index < maxLength; index += 1) {
        difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
    }
    return difference === 0;
}

function apiPath(pathname: string): string {
    for (const prefix of ["/functions/v1/sogo", "/sogo"]) {
        const index = pathname.indexOf(prefix);
        if (index >= 0) {
            return pathname.slice(index + prefix.length) || "/";
        }
    }
    return pathname || "/";
}

function responseHeaders(request: Request, cookie?: string): Headers {
    const headers = new Headers({
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Security-Policy": [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "connect-src 'self'",
            "img-src 'self' data:",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ].join("; "),
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
    });
    const origin = request.headers.get("origin");
    if (origin) {
        try {
            const originUrl = new URL(origin);
            if (allowedOrigins.has(originUrl.origin)) {
                headers.set("Access-Control-Allow-Origin", originUrl.origin);
                headers.set("Access-Control-Allow-Credentials", "true");
                headers.set("Vary", "Origin");
            }
        } catch {
            return headers;
        }
    }
    if (request.method === "OPTIONS") {
        headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Content-Type");
        headers.set("Access-Control-Max-Age", "86400");
    }
    if (cookie) {
        headers.append("Set-Cookie", cookie);
    }
    return headers;
}

function sendJson(
    request: Request,
    statusCode: number,
    value: unknown,
    cookie?: string,
): Response {
    return new Response(JSON.stringify(value), {
        status: statusCode,
        headers: responseHeaders(request, cookie),
    });
}

type DatabaseQuery<T> = PromiseLike<{ data: T | null; error: unknown }>;

async function queryDatabase<T>(query: DatabaseQuery<T>): Promise<T> {
    const { data, error } = await query;
    if (error) {
        throw error;
    }
    if (data === null) {
        throw new Error("Supabase returned no data.");
    }
    return data;
}

async function queryMaybeSingle<T>(query: DatabaseQuery<T>): Promise<T | null> {
    const { data, error } = await query;
    if (error) {
        throw error;
    }
    return data;
}

async function executeDatabase<T>(query: DatabaseQuery<T>): Promise<void> {
    const { error } = await query;
    if (error) {
        throw error;
    }
}

function errorCode(error: unknown): string | undefined {
    if (typeof error === "object" && error !== null && "code" in error) {
        const code = error.code;
        return typeof code === "string" ? code : undefined;
    }
    return undefined;
}
