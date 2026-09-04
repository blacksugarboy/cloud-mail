import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import dayjs from 'dayjs';
import { dbInit } from '../src/init/init';
import userService from '../src/service/user-service';
import settingService from '../src/service/setting-service';
import regKeyService from '../src/service/reg-key-service';
import emailService from '../src/service/email-service';
import oauthService from '../src/service/oauth-service';
import webhookService from '../src/service/webhook-service';
import { email as receiveEmail } from '../src/email/email';

const password = 'local-test-password';
const upstreamSettingColumns = [
	'sync_delete', 'linuxdo_client_id', 'linuxdo_client_secret', 'linuxdo_switch',
	'github_client_id', 'github_client_secret', 'github_switch',
	'google_client_id', 'google_client_secret', 'google_switch',
	'auto_clean_days', 'auto_clean_exclude', 'webhook_url', 'webhook_status',
	'webhook_retry', 'webhook_secret'
];
let adminToken;
let adminId;

function context(extraEnv = {}) {
	const values = new Map();
	return {
		env: { ...env, ...extraEnv },
		get: key => values.get(key),
		set: (key, value) => values.set(key, value),
		req: { param: () => env.jwt_secret, header: () => undefined },
		text: text => new Response(text)
	};
}

async function api(path, { method = 'GET', body, token = adminToken } = {}) {
	const response = await SELF.fetch(`https://local.test/api${path}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			'Accept-Language': 'en',
			'CF-Connecting-IP': '127.0.0.1',
			...(token ? { Authorization: token } : {})
		},
		...(body ? { body: JSON.stringify(body) } : {})
	});
	return response.json();
}

async function ok(path, options) {
	const result = await api(path, options);
	expect(result, path).toMatchObject({ code: 200 });
	return result.data;
}

async function setSettings(settings) {
	await ok('/setting/set', { method: 'PUT', body: settings });
}

async function createUser(name, validType = 'year', type = 1) {
	const email = `${name}@example.com`;
	await ok('/user/add', { method: 'POST', body: { email, password, type, validType } });
	return userService.selectByEmail(context(), email);
}

async function login(email) {
	const { token } = await ok('/login', { method: 'POST', body: { email, password }, token: null });
	return token;
}

async function createCode(code, extra = {}) {
	await ok('/regKey/add', {
		method: 'POST',
		body: { code, count: 1, roleId: 1, expireTime: '2099-12-31', userValidity: 'year', ...extra }
	});
}

async function seedEmail(userId, extra = {}) {
	const account = await env.db.prepare('SELECT * FROM account WHERE user_id = ? ORDER BY account_id LIMIT 1').bind(userId).first();
	const row = await emailService.receive(context(), {
		accountId: account.account_id, userId, sendEmail: 'sender@example.com',
		toEmail: account.email, name: 'Sender', subject: 'Merge regression',
		text: 'Hello from upstream', content: '<p>Hello from upstream</p>',
		recipient: JSON.stringify([{ address: account.email }]), status: 0,
		...extra
	}, [], '');
	return { ...row, accountId: account.account_id };
}

beforeAll(async () => {
	const response = await SELF.fetch(`https://local.test/api/init/${env.jwt_secret}`);
	expect(await response.text()).toBe('success');
	await ok('/register', { method: 'POST', body: { email: env.admin, password }, token: null });
	adminToken = await login(env.admin);
	adminId = (await userService.selectByEmail(context(), env.admin)).userId;
});

afterEach(() => vi.restoreAllMocks());

describe('upstream schema and custom migrations', () => {
	it('initializes without AI and can run init repeatedly without overwriting validity', async () => {
		const existing = await createUser('existing', 'week');
		await env.db.prepare("INSERT INTO user (email, password, salt, valid_type) VALUES ('legacy@example.com', '', '', NULL)").run();
		await env.db.prepare("ALTER TABLE email ADD COLUMN code TEXT DEFAULT ''").run();
		await env.db.prepare('ALTER TABLE setting ADD COLUMN ai_code INTEGER').run();
		await env.db.prepare('ALTER TABLE setting ADD COLUMN ai_code_filter TEXT').run();
		for (let i = 0; i < 2; i++) {
			const response = await SELF.fetch(`https://local.test/api/init/${env.jwt_secret}`);
			expect(await response.text()).toBe('success');
		}
		expect(await userService.selectById(context(), existing.userId)).toMatchObject({
			validType: 'week', validStartTime: existing.validStartTime, validEndTime: existing.validEndTime
		});
		expect(await userService.selectByEmail(context(), 'legacy@example.com')).toMatchObject({ validType: 'permanent', validEndTime: null });
		expect(await userService.selectById(context(), adminId)).toMatchObject({ validType: 'permanent', validEndTime: null });
		const settings = await env.db.prepare("SELECT name FROM pragma_table_info('setting')").all();
		const columns = settings.results.map(row => row.name);
		expect(columns).toEqual(expect.arrayContaining(upstreamSettingColumns));
		expect(columns).not.toContain('ai_code');
		expect(columns).not.toContain('ai_code_filter');
		expect(await env.db.prepare("SELECT name FROM pragma_table_info('email') WHERE name = 'code'").first()).toBeNull();
		expect((await env.db.prepare("SELECT count(*) AS n FROM perm WHERE perm_key = 'user:set-validity'").first()).n).toBe(1);
	});

	it('upgrades the 3.0.1 schema and imports old LinuxDo settings only once', async () => {
		const existing = await createUser('upgrade', 'month');
		for (const column of upstreamSettingColumns) {
			await env.db.prepare(`ALTER TABLE setting DROP COLUMN ${column}`).run();
		}
		const legacyEnv = { linuxdo_client_id: 'old-client', linuxdo_client_secret: 'old-secret', linuxdo_switch: 'true' };
		await env.db.prepare("INSERT INTO oauth (oauth_user_id, user_id, platform) VALUES ('legacy-oauth', ?, '0')").bind(existing.userId).run();
		expect(await (await dbInit.init(context(legacyEnv))).text()).toBe('success');
		let settings = await env.db.prepare('SELECT * FROM setting').first();
		expect(settings).toMatchObject({ linuxdo_client_id: 'old-client', linuxdo_switch: 0, sync_delete: 1, auto_clean_days: 0 });
		await env.db.prepare("UPDATE setting SET linuxdo_client_id = 'new-client', linuxdo_switch = 1").run();
		await dbInit.init(context(legacyEnv));
		settings = await env.db.prepare('SELECT * FROM setting').first();
		expect(settings).toMatchObject({ linuxdo_client_id: 'new-client', linuxdo_switch: 1 });
		expect(await userService.selectById(context(), existing.userId)).toMatchObject({ validEndTime: existing.validEndTime });
		expect(await oauthService.getById(context(), 'legacy-oauth', 'linuxdo')).toMatchObject({ userId: existing.userId });
		expect(await env.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_email_list_user'").first()).not.toBeNull();
	});
});

describe('registration and user validity', () => {
	it('keeps multi-use codes and batches distinct one-time codes', async () => {
		await createCode('MULTI', { count: 3 });
		const codes = await ok('/regKey/batchAdd', { method: 'POST', body: { quantity: 5, roleId: 1, expireTime: '2099-12-31', userValidity: 'week' } });
		expect(new Set(codes).size).toBe(5);
		for (const code of codes) expect(await regKeyService.selectByCode(context(), code)).toMatchObject({ count: 1, userValidity: 'week' });
		expect(await regKeyService.selectByCode(context(), 'MULTI')).toMatchObject({ count: 3, userValidity: 'year' });
		await setSettings({ regKey: 0 });
		await ok('/register', { method: 'POST', token: null, body: { email: 'single@example.com', password, code: codes[0] } });
		expect((await api('/register', { method: 'POST', token: null, body: { email: 'again@example.com', password, code: codes[0] } })).code).not.toBe(200);
		expect((await regKeyService.selectByCode(context(), codes[0])).count).toBe(0);
	});

	it.each(['week', 'month', 'year', 'permanent'])('registers users with the code validity: %s', async validType => {
		await setSettings({ regKey: 0 });
		await createCode('VALIDITY', { userValidity: validType });
		await ok('/register', { method: 'POST', token: null, body: { email: 'duration@example.com', password, code: 'VALIDITY' } });
		const row = await userService.selectByEmail(context(), 'duration@example.com');
		expect(row.validType).toBe(validType);
		if (validType === 'permanent') {
			expect(row.validEndTime).toBeNull();
		} else {
			expect(dayjs(row.validStartTime).add(1, validType).format('YYYY-MM-DD HH:mm:ss')).toBe(row.validEndTime);
			expect(Math.abs(dayjs().diff(dayjs(row.validStartTime), 'second'))).toBeLessThan(10);
		}
	});

	it('includes validity in the user list and respects editing permissions', async () => {
		const target = await createUser('target');
		const noPermissionToken = await login(target.email);
		expect((await api('/user/setValidity', { method: 'PUT', token: noPermissionToken, body: { userId: adminId, validType: 'permanent' } })).code).toBe(403);
		await env.db.prepare("INSERT INTO role (role_id, name, account_count, avail_domain) VALUES (2, 'Validity manager', 3, 'example.com')").run();
		await env.db.prepare("INSERT INTO role_perm (role_id, perm_id) SELECT 2, perm_id FROM perm WHERE perm_key = 'user:set-validity'").run();
		const manager = await createUser('manager', 'permanent', 2);
		const peer = await createUser('peer', 'permanent', 2);
		const managerToken = await login(manager.email);
		for (const userId of [adminId, manager.userId, peer.userId]) {
			expect((await api('/user/setValidity', { method: 'PUT', token: managerToken, body: { userId, validType: 'year' } })).code).not.toBe(200);
		}
		await ok('/user/setValidity', { method: 'PUT', token: managerToken, body: { userId: target.userId, validType: 'month' } });
		const changed = await userService.selectById(context(), target.userId);
		expect(changed.validType).toBe('month');
		expect(dayjs(changed.validStartTime).add(1, 'month').format('YYYY-MM-DD HH:mm:ss')).toBe(changed.validEndTime);
		await ok('/user/setValidity', { method: 'PUT', body: { userId: target.userId, validType: 'range', validStartTime: '2000-01-01 00:00:00', validEndTime: '2001-01-01 00:00:00' } });
		const data = await ok('/user/list?size=20&status=2');
		expect(data.list.find(row => row.userId === target.userId)).toMatchObject({ validType: 'range', validEndTime: '2001-01-01 00:00:00', status: 2 });
	});

	it.each(['expired', 'future'])('blocks %s accounts for password login, OAuth and existing sessions', async state => {
		const row = await createUser(state);
		const token = await login(row.email);
		const start = state === 'expired' ? '2000-01-01' : '2098-01-01';
		const end = state === 'expired' ? '2001-01-01' : '2099-01-01';
		await env.db.prepare("UPDATE user SET valid_type = 'range', valid_start_time = ?, valid_end_time = ? WHERE user_id = ?").bind(start, end, row.userId).run();
		expect((await api('/login', { method: 'POST', token: null, body: { email: row.email, password } })).code).not.toBe(200);
		expect((await api('/my/loginUserInfo', { token })).code).toBe(401);
		await env.db.prepare("INSERT INTO oauth (oauth_user_id, user_id, platform) VALUES ('test-id', ?, 'github')").bind(row.userId).run();
		await expect(oauthService.saveAndLogin(context(), { oauthUserId: 'test-id', platform: 'github' })).rejects.toThrow();
	});
});

describe('multi-provider OAuth compatibility', () => {
	it('keeps matching external IDs isolated between LinuxDo, GitHub and Google', async () => {
		await env.db.prepare("INSERT INTO oauth (oauth_user_id, user_id, platform) VALUES ('shared-id', ?, 'linuxdo')").bind(adminId).run();
		for (const platform of ['github', 'google']) {
			const result = await oauthService.saveAndLogin(context(), { oauthUserId: 'shared-id', platform, username: platform });
			expect(result.token).toBeNull();
			expect(result.userInfo).toMatchObject({ platform, userId: 0 });
		}
		expect(await oauthService.getById(context(), 'shared-id', 'linuxdo')).toMatchObject({ userId: adminId });
		const result = await oauthService.saveAndLogin(context(), { oauthUserId: 'shared-id', platform: 'linuxdo' });
		expect(result.token).toBeTruthy();
	});

	it('binds only the selected provider and preserves registration-code validity', async () => {
		await env.db.prepare("INSERT INTO oauth (oauth_user_id, user_id, platform) VALUES ('bind-id', ?, 'linuxdo')").bind(adminId).run();
		await oauthService.saveUser(context(), { oauthUserId: 'bind-id', platform: 'github' });
		await setSettings({ regKey: 0 });
		await createCode('OAUTH', { userValidity: 'week' });
		const data = await ok('/oauth/bindUser', {
			method: 'PUT', token: null,
			body: { email: 'oauthbind@example.com', oauthUserId: 'bind-id', platform: 'github', code: 'OAUTH' }
		});
		expect(data.token).toBeTruthy();
		const row = await userService.selectByEmail(context(), 'oauthbind@example.com');
		expect(row.validType).toBe('week');
		expect(await oauthService.getById(context(), 'bind-id', 'github')).toMatchObject({ userId: row.userId });
		expect(await oauthService.getById(context(), 'bind-id', 'linuxdo')).toMatchObject({ userId: adminId });
		expect((await regKeyService.selectByCode(context(), 'OAUTH')).count).toBe(0);
	});
});

describe('multi-address mode with upstream plus addresses', () => {
	it('allows default-role codes to bypass only the add-address switch', async () => {
		const row = await createUser('multi');
		const token = await login(row.email);
		await env.db.prepare('UPDATE role SET account_count = 2 WHERE role_id = 1').run();
		await createCode('ADD', { count: 3 });
		await setSettings({ addEmail: 1, manyEmail: 0 });
		const withoutCode = await api('/account/add', { method: 'POST', token, body: { email: 'extra@example.com' } });
		expect(withoutCode.code).not.toBe(200);
		expect(withoutCode.message).toMatch(/code/i);
		await ok('/account/add', { method: 'POST', token, body: { email: 'extra@example.com', code: 'ADD' } });
		expect((await regKeyService.selectByCode(context(), 'ADD')).count).toBe(2);
		expect((await api('/account/add', { method: 'POST', token, body: { email: 'third@example.com', code: 'ADD' } })).code).toBe(403);
		await setSettings({ manyEmail: 1 });
		expect((await api('/account/add', { method: 'POST', token, body: { email: 'third@example.com', code: 'ADD' } })).code).not.toBe(200);
		expect((await ok('/account/list?size=30', { token })).map(item => item.email)).toEqual(expect.arrayContaining([row.email, 'extra@example.com']));
		expect((await ok('/my/loginUserInfo', { token })).accountTotal).toBe(2);
		expect((await regKeyService.selectByCode(context(), 'ADD')).count).toBe(2);
	});

	it('rejects non-default-role codes and other users plus addresses without consuming a code', async () => {
		const row = await createUser('owner');
		await createUser('other');
		const token = await login(row.email);
		await env.db.prepare("INSERT INTO role (role_id, name, account_count) VALUES (2, 'Other role', 5)").run();
		await createCode('WRONGROLE', { roleId: 2 });
		await createCode('PLUS');
		await setSettings({ addEmail: 1 });
		expect((await api('/account/add', { method: 'POST', token, body: { email: 'extra@example.com', code: 'WRONGROLE' } })).code).not.toBe(200);
		expect((await api('/account/add', { method: 'POST', token, body: { email: 'other+tag@example.com', code: 'PLUS' } })).code).not.toBe(200);
		expect((await regKeyService.selectByCode(context(), 'PLUS')).count).toBe(1);
		await ok('/account/add', { method: 'POST', token, body: { email: 'owner+tag@example.com', code: 'PLUS' } });
	});
});

describe('upstream mail features without Workers AI', () => {
	it('queries brief/full mail, starred mail, all mail, and read status without deleted AI columns', async () => {
		const row = await createUser('mailbox');
		const token = await login(row.email);
		const email = await seedEmail(row.userId);
		await env.db.prepare('INSERT INTO star (user_id, email_id) VALUES (?, ?)').bind(row.userId, email.emailId).run();
		for (const full of [0, 1]) {
			for (const path of [`/email/list?accountId=${email.accountId}&size=10&full=${full}`, `/star/list?size=10&full=${full}`, `/allEmail/list?size=10&full=${full}`]) {
				const data = await ok(path, { token: path.startsWith('/allEmail') ? adminToken : token });
				expect(data.list[0]).toMatchObject({ emailId: email.emailId, subject: 'Merge regression' });
				expect(data.list[0]).not.toHaveProperty('code');
			}
		}
		await ok('/email/read', { method: 'PUT', token, body: { emailIds: [email.emailId] } });
		expect((await env.db.prepare('SELECT unread FROM email WHERE email_id = ?').bind(email.emailId).first()).unread).toBe(1);
	});

	it('routes incoming plus-address mail to its base mailbox', async () => {
		const row = await createUser('plusmail');
		const message = {
			to: 'plusmail+tag@example.com',
			raw: new Response('From: sender@example.com\r\nTo: plusmail+tag@example.com\r\nSubject: Plus address\r\nContent-Type: text/plain\r\n\r\nHello').body,
			setReject: vi.fn()
		};
		await receiveEmail(message, env, {});
		expect(message.setReject).not.toHaveBeenCalled();
		expect(await env.db.prepare('SELECT user_id, to_email FROM email WHERE subject = ?').bind('Plus address').first()).toMatchObject({ user_id: row.userId, to_email: message.to });
	});

	it('preserves soft deletion by default, with permanent deletion opt-in', async () => {
		const row = await createUser('deletion');
		const token = await login(row.email);
		const email = await seedEmail(row.userId);
		expect((await settingService.query(context())).syncDelete).toBe(1);
		await ok(`/email/delete?emailIds=${email.emailId}`, { method: 'DELETE', token });
		expect(await env.db.prepare('SELECT is_del FROM email WHERE email_id = ?').bind(email.emailId).first()).toMatchObject({ is_del: 1 });
		await setSettings({ syncDelete: 0 });
		await ok(`/email/delete?emailIds=${email.emailId}`, { method: 'DELETE', token });
		expect(await env.db.prepare('SELECT email_id FROM email WHERE email_id = ?').bind(email.emailId).first()).toBeNull();
	});

	it('cleans old mail only when enabled and retains excluded users mail', async () => {
		const row = await createUser('cleanup');
		const old = await seedEmail(row.userId, { createTime: '2000-01-01 00:00:00' });
		const recent = await seedEmail(row.userId);
		const excluded = await seedEmail(adminId, { createTime: '2000-01-01 00:00:00' });
		await emailService.autoClean(context());
		expect((await env.db.prepare('SELECT count(*) AS n FROM email').first()).n).toBe(3);
		await setSettings({ autoCleanDays: 7, autoCleanExclude: env.admin });
		await emailService.autoClean(context());
		const rows = (await env.db.prepare('SELECT email_id FROM email').all()).results.map(row => row.email_id);
		expect(rows).toEqual(expect.arrayContaining([recent.emailId, excluded.emailId]));
		expect(rows).not.toContain(old.emailId);
	});

	it('sends and retries webhooks without an AI payload or external network requests', async () => {
		const fetch = vi.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response('retry', { status: 503 }))
			.mockResolvedValueOnce(new Response('ok'));
		await webhookService.sendEmail(context(), { emailId: 1, subject: 'Test' }, 'https://webhook.example.com/mail', 1, 'local-secret');
		expect(fetch).toHaveBeenCalledTimes(2);
		const [url, options] = fetch.mock.calls[1];
		expect(url).toBe('https://webhook.example.com/mail');
		expect(options.headers.Authorization).toBe('local-secret');
		expect(JSON.parse(options.body)).toMatchObject({ emailId: 1, subject: 'Test' });
		expect(JSON.parse(options.body)).not.toHaveProperty('code');
	});
});
