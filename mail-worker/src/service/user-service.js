import BizError from '../error/biz-error';
import accountService from './account-service';
import orm from '../entity/orm';
import user from '../entity/user';
import { and, asc, count, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { emailConst, isDel, roleConst, settingConst, userConst } from '../const/entity-const';
import kvConst from '../const/kv-const';
import KvConst from '../const/kv-const';
import cryptoUtils from '../utils/crypto-utils';
import emailService from './email-service';
import dayjs from 'dayjs';
import permService from './perm-service';
import roleService from './role-service';
import emailUtils from '../utils/email-utils';
import saltHashUtils from '../utils/crypto-utils';
import constant from '../const/constant';
import { t } from '../i18n/i18n'
import reqUtils from '../utils/req-utils';
import {oauth} from "../entity/oauth";
import oauthService from "./oauth-service";
import settingService from './setting-service';
import starService from './star-service';

const userService = {

	async loginUserInfo(c, userId) {

		const userRow = await userService.selectById(c, userId);

		if (!userRow) {
			throw new BizError(t('authExpired'), 401);
		}

		const [account, roleRow, permKeys, accountTotal] = await Promise.all([
			accountService.selectByEmailIncludeDel(c, userRow.email),
			roleService.selectById(c, userRow.type),
			userRow.email === c.env.admin ? Promise.resolve(['*']) : permService.userPermKeys(c, userId),
			accountService.countUserAccount(c, userId)
		]);

		const user = {};
		user.userId = userRow.userId;
		user.sendCount = userRow.sendCount;
		user.email = userRow.email;
		user.account = account;
		user.accountTotal = accountTotal;
		user.name = account.name;
		user.permKeys = permKeys;
		user.role = roleRow;
		user.type = userRow.type;
		user.status = this.getEffectiveStatus(userRow, c.env.admin);
		user.validType = userRow.validType;
		user.validStartTime = userRow.validStartTime;
		user.validEndTime = userRow.validEndTime;

		if (c.env.admin === userRow.email) {
			user.role = constant.ADMIN_ROLE
			user.type = 0;
			user.validType = userConst.validity.PERMANENT;
			user.validStartTime = null;
			user.validEndTime = null;
		}

		return user;
	},


	async resetPassword(c, params, userId) {

		const { password } = params;

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}
		const { salt, hash } = await cryptoUtils.hashPassword(password);
		await orm(c).update(user).set({ password: hash, salt: salt }).where(eq(user.userId, userId)).run();
	},

	selectByEmail(c, email) {
		return orm(c).select().from(user).where(
			and(
				sql`${user.email} COLLATE NOCASE = ${email}`,
				eq(user.isDel, isDel.NORMAL)))
			.get();
	},

	async insert(c, params) {
		const validity = params.email === c.env.admin
			? this.buildValidity(userConst.validity.PERMANENT)
			: this.buildValidity(
				params.validType,
				params.validStartTime,
				params.validEndTime
			);
		const { userId } = await orm(c).insert(user).values({ ...params, ...validity }).returning().get();
		return userId;
	},

	buildValidity(validType = userConst.validity.YEAR, validStartTime, validEndTime, baseTime = dayjs()) {
		const presetTypes = [
			userConst.validity.WEEK,
			userConst.validity.MONTH,
			userConst.validity.YEAR,
			userConst.validity.PERMANENT
		];

		if (validType === userConst.validity.RANGE) {
			const start = dayjs(validStartTime);
			const end = dayjs(validEndTime);
			if (!start.isValid() || !end.isValid() || !end.isAfter(start)) {
				throw new BizError(t('invalidValidityRange'));
			}
			return {
				validType,
				validStartTime: start.format('YYYY-MM-DD HH:mm:ss'),
				validEndTime: end.format('YYYY-MM-DD HH:mm:ss')
			};
		}

		if (!presetTypes.includes(validType)) {
			throw new BizError(t('invalidValidityType'));
		}

		if (validType === userConst.validity.PERMANENT) {
			return {
				validType,
				validStartTime: null,
				validEndTime: null
			};
		}

		const start = dayjs(baseTime);
		const unit = validType === userConst.validity.WEEK ? 'week' : validType;
		return {
			validType,
			validStartTime: start.format('YYYY-MM-DD HH:mm:ss'),
			validEndTime: start.add(1, unit).format('YYYY-MM-DD HH:mm:ss')
		};
	},

	isUserValid(userRow, adminEmail) {
		if (!userRow) {
			return false;
		}
		if (userRow.email === adminEmail || userRow.validType === userConst.validity.PERMANENT) {
			return true;
		}
		if (!userRow.validStartTime || !userRow.validEndTime) {
			return false;
		}
		const now = dayjs();
		const start = dayjs(userRow.validStartTime);
		const end = dayjs(userRow.validEndTime);
		return start.isValid() && end.isValid()
			&& !now.isBefore(start)
			&& !now.isAfter(end);
	},

	getEffectiveStatus(userRow, adminEmail) {
		return this.isUserValid(userRow, adminEmail)
			? userRow.status
			: userConst.status.INVALID;
	},

	selectByEmailIncludeDel(c, email) {
		return orm(c).select().from(user).where(sql`${user.email} COLLATE NOCASE = ${email}`).get();
	},

	selectByIdIncludeDel(c, userId) {
		return orm(c).select().from(user).where(eq(user.userId, userId)).get();
	},

	selectById(c, userId) {
		return orm(c).select().from(user).where(
			and(
				eq(user.userId, userId),
				eq(user.isDel, isDel.NORMAL)))
			.get();
	},

	async delete(c, userId) {
		const { syncDelete } = await settingService.query(c);
		if (syncDelete === settingConst.syncDelete.OPEN) {
			await this.physicsDelete(c, { userIds: String(userId) });
			await c.env.kv.delete(kvConst.AUTH_INFO + userId)
			return;
		}
		await orm(c).update(user).set({ isDel: isDel.DELETE }).where(eq(user.userId, userId)).run();
		await c.env.kv.delete(kvConst.AUTH_INFO + userId)
	},

	async physicsDelete(c, params) {
		let { userIds } = params;
		userIds = userIds.split(',').map(Number);
		await starService.removeByUserIds(c, userIds);
		await accountService.physicsDeleteByUserIds(c, userIds);
		await oauthService.deleteByUserIds(c, userIds);
		await orm(c).delete(user).where(inArray(user.userId, userIds)).run();
	},

	async list(c, params) {

		let { num, size, email, timeSort, status } = params;

		size = Number(size);
		num = Number(num);
		timeSort = Number(timeSort);
		params.isDel = Number(params.isDel);

		if (isNaN(size)) {
			size = 50;
		}

		if (isNaN(num)) {
			num = 1;
		}

		if (size > 50) {
			size = 50;
		}

		num = (num - 1) * size;

		const conditions = [];

		const invalidValidity = and(
			ne(user.email, c.env.admin),
			or(
				isNull(user.validType),
				ne(user.validType, userConst.validity.PERMANENT)
			),
			or(
				isNull(user.validStartTime),
				isNull(user.validEndTime),
				sql`datetime(${user.validStartTime}) > datetime(CURRENT_TIMESTAMP)`,
				sql`datetime(${user.validEndTime}) < datetime(CURRENT_TIMESTAMP)`
			)
		);
		const activeValidity = or(
			eq(user.email, c.env.admin),
			eq(user.validType, userConst.validity.PERMANENT),
			and(
				sql`datetime(${user.validStartTime}) <= datetime(CURRENT_TIMESTAMP)`,
				sql`datetime(${user.validEndTime}) >= datetime(CURRENT_TIMESTAMP)`
			)
		);

		status = Number(status);
		if (status > -1) {
			if (status === userConst.status.INVALID) {
				conditions.push(invalidValidity);
			} else {
				conditions.push(eq(user.status, status));
				conditions.push(activeValidity);
			}
			conditions.push(eq(user.isDel, isDel.NORMAL));
		}


		if (email) {
			conditions.push(sql`${user.email} COLLATE NOCASE LIKE ${email + '%'}`);
		}


		if (params.isDel) {
			conditions.push(eq(user.isDel, params.isDel));
		}


		const query = orm(c).select({
			...user,
			username: oauth.username,
			trustLevel: oauth.trustLevel,
			avatar: oauth.avatar,
			name: oauth.name,
			platform: oauth.platform
		}).from(user).leftJoin(oauth, eq(oauth.userId, user.userId))
			.where(and(...conditions));


		if (timeSort) {
			query.orderBy(asc(user.userId));
		} else {
			query.orderBy(desc(user.userId));
		}

		const list = await query.limit(size).offset(num);

		const { total } = await orm(c)
			.select({ total: count() })
			.from(user)
			.where(and(...conditions)).get();
		const userIds = list.map(user => user.userId);

		const types = [...new Set(list.map(user => user.type))];

		const [emailCounts, delEmailCounts, sendCounts, delSendCounts, accountCounts, delAccountCounts, roleList, validityPermRoles] = await Promise.all([
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.RECEIVE),
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.RECEIVE, isDel.DELETE),
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.SEND),
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.SEND, isDel.DELETE),
			accountService.selectUserAccountCountList(c, userIds),
			accountService.selectUserAccountCountList(c, userIds, isDel.DELETE),
			roleService.selectByIdsHasPermKey(c, types,'email:send'),
			roleService.selectByIdsHasPermKey(c, types,'user:set-validity')
		]);

		const receiveMap = Object.fromEntries(emailCounts.map(item => [item.userId, item.count]));
		const sendMap = Object.fromEntries(sendCounts.map(item => [item.userId, item.count]));
		const accountMap = Object.fromEntries(accountCounts.map(item => [item.userId, item.count]));

		const delReceiveMap = Object.fromEntries(delEmailCounts.map(item => [item.userId, item.count]));
		const delSendMap = Object.fromEntries(delSendCounts.map(item => [item.userId, item.count]));
		const delAccountMap = Object.fromEntries(delAccountCounts.map(item => [item.userId, item.count]));

		for (const user of list) {

			const userId = user.userId;
			user.accountStatus = user.status;
			user.hasValidityPerm = validityPermRoles.some(roleRow => user.type === roleRow.roleId);

			user.receiveEmailCount = receiveMap[userId] || 0;
			user.sendEmailCount = sendMap[userId] || 0;
			user.accountCount = accountMap[userId] || 0;

			user.delReceiveEmailCount = delReceiveMap[userId] || 0;
			user.delSendEmailCount = delSendMap[userId] || 0;
			user.delAccountCount = delAccountMap[userId] || 0;

			const roleIndex = roleList.findIndex(roleRow => user.type === roleRow.roleId);
			let sendAction = {};

			if (roleIndex > -1) {
				sendAction.sendType = roleList[roleIndex].sendType;
				sendAction.sendCount = roleList[roleIndex].sendCount;
				sendAction.hasPerm = true;
			} else {
				sendAction.hasPerm = false;
			}

			if (user.email === c.env.admin) {
				sendAction.sendType = constant.ADMIN_ROLE.sendType;
				sendAction.sendCount = constant.ADMIN_ROLE.sendCount;
				sendAction.hasPerm = true;
				user.type = 0
				user.validType = userConst.validity.PERMANENT;
				user.validStartTime = null;
				user.validEndTime = null;
				user.hasValidityPerm = true;
			}

			user.sendAction = sendAction;
			user.status = this.getEffectiveStatus(user, c.env.admin);
		}

		return { list, total };
	},

	async updateUserInfo(c, userId, recordCreateIp = false) {



		const activeIp = reqUtils.getIp(c);

		const {os, browser, device} = reqUtils.getUserAgent(c);

		const params = {
			os,
			browser,
			device,
			activeIp,
			activeTime: dayjs().format('YYYY-MM-DD HH:mm:ss')
		};

		if (recordCreateIp) {
			params.createIp = activeIp;
		}

		await orm(c)
			.update(user)
			.set(params)
			.where(eq(user.userId, userId))
			.run();
	},

	async setPwd(c, params) {

		const { password, userId } = params;
		await this.resetPassword(c, { password }, userId);
		await c.env.kv.delete(KvConst.AUTH_INFO + userId);
	},

	async setStatus(c, params) {

		const { status, userId } = params;

		await orm(c)
			.update(user)
			.set({ status })
			.where(eq(user.userId, userId))
			.run();

		if (status === userConst.status.BAN) {
			await c.env.kv.delete(KvConst.AUTH_INFO + userId);
		}
	},

	async setValidity(c, params, operatorUserId) {
		const { userId, validType, validStartTime, validEndTime } = params;
		const targetUserId = Number(userId);
		const [operator, target] = await Promise.all([
			this.selectById(c, operatorUserId),
			this.selectById(c, targetUserId)
		]);

		if (!operator || !target) {
			throw new BizError(t('notExistUser'));
		}
		if (target.email === c.env.admin) {
			throw new BizError(t('adminValidityPermanent'));
		}
		if (target.userId === operator.userId) {
			throw new BizError(t('cannotSetOwnValidity'));
		}

		if (operator.email !== c.env.admin) {
			const targetPermKeys = await permService.userPermKeys(c, target.userId);
			if (targetPermKeys.includes('user:set-validity')) {
				throw new BizError(t('cannotSetValidityPeer'));
			}
		}

		const validity = this.buildValidity(validType, validStartTime, validEndTime);
		await orm(c)
			.update(user)
			.set(validity)
			.where(eq(user.userId, target.userId))
			.run();
		await c.env.kv.delete(KvConst.AUTH_INFO + target.userId);
		return validity;
	},

	async setType(c, params) {

		const { type, userId } = params;

		const roleRow = await roleService.selectById(c, type);

		if (!roleRow) {
			throw new BizError(t('roleNotExist'));
		}

		await orm(c)
			.update(user)
			.set({ type })
			.where(eq(user.userId, userId))
			.run();

	},

	async incrUserSendCount(c, quantity, userId) {
		await orm(c).update(user).set({
			sendCount: sql`${user.sendCount}
	  +
	  ${quantity}`
		}).where(eq(user.userId, userId)).run();
	},

	async updateAllUserType(c, type, curType) {
		await orm(c)
			.update(user)
			.set({ type })
			.where(eq(user.type, curType))
			.run();
	},

	async add(c, params) {

		let { email, type, password, validType } = params;

		if (!c.env.domain.includes(emailUtils.getDomain(email))) {
			throw new BizError(t('notEmailDomain'));
		}

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		let role;
		if (type === undefined) {
			role = await roleService.selectDefaultRole(c);
			type = role?.roleId;
		} else {
			role = await roleService.selectById(c, type);
		}

		if (!role) {
			throw new BizError(t('roleNotExist'));
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);

		const userId = await userService.insert(c, { email, password: hash, salt, type, validType });

		await userService.updateUserInfo(c, userId, true);

		await accountService.insert(c, { userId: userId, email, type, name: emailUtils.getName(email) });
	},

	async resetDaySendCount(c) {
		// 仅 UTC 0 点执行，便于配合每小时 cron
		if (new Date().getUTCHours() !== 0) {
			return;
		}
		const roleList = await roleService.selectByIdsAndSendType(c, 'email:send', roleConst.sendType.DAY);
		const roleIds = roleList.map(action => action.roleId);
		await orm(c).update(user).set({ sendCount: 0 }).where(inArray(user.type, roleIds)).run();
	},

	async resetSendCount(c, params) {
		await orm(c).update(user).set({ sendCount: 0 }).where(eq(user.userId, params.userId)).run();
	},

	async restore(c, params) {
		const { userId, type } = params
		await orm(c)
			.update(user)
			.set({ isDel: isDel.NORMAL })
			.where(eq(user.userId, userId))
			.run();
		const userRow = await this.selectById(c, userId);
		await accountService.restoreByEmail(c, userRow.email);

		if (type) {
			await emailService.restoreByUserId(c, userId);
			await accountService.restoreByUserId(c, userId);
		}

	},

	listByRegKeyId(c, regKeyId) {
		return orm(c)
			.select({email: user.email,createTime: user.createTime})
			.from(user)
			.where(eq(user.regKeyId, regKeyId))
			.orderBy(desc(user.userId))
			.all();
	}
};

export default userService;
