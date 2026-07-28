import orm from '../entity/orm';
import regKey from '../entity/reg-key';
import { and, desc, eq, gte, inArray, like, or, sql } from 'drizzle-orm';
import roleService from './role-service';
import BizError from '../error/biz-error';
import { formatDetailDate, toUtc } from '../utils/date-uitil';
import userService from './user-service';
import { t } from '../i18n/i18n.js';
import { userConst } from '../const/entity-const';

const MAX_BATCH_COUNT = 200;
const REG_KEY_LENGTH = 12;
const REG_KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const regKeyService = {

	async add(c, params, userId) {

		let {code,roleId,count,expireTime,userValidity} = params;
		count = Number(count);

		if (!code) {
			throw new BizError(t('emptyRegKey'));
		}

		if (!Number.isInteger(count) || count < 1) {
			throw new BizError(t('regKeyUseCount'));
		}

		const validated = await this.validateRoleAndExpireTime(c, roleId, expireTime);
		userValidity = this.validateUserValidity(userValidity);

		const regKeyRow = await orm(c).select().from(regKey).where(eq(regKey.code, code)).get();

		if (regKeyRow) {
			throw new BizError(t('isExistRegKye'));
		}

		await orm(c).insert(regKey).values({
			code,
			roleId: validated.roleId,
			count,
			userId,
			expireTime: validated.expireTime,
			userValidity
		}).run();
	},

	async batchAdd(c, params, userId) {
		let { quantity, roleId, expireTime, userValidity } = params;
		quantity = Number(quantity);

		if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_BATCH_COUNT) {
			throw new BizError(t('batchRegKeyCountRange', { max: MAX_BATCH_COUNT }));
		}

		const validated = await this.validateRoleAndExpireTime(c, roleId, expireTime);
		userValidity = this.validateUserValidity(userValidity);
		const codes = new Set();

		while (codes.size < quantity) {
			codes.add(this.generateCode());
		}

		const rows = Array.from(codes).map(code => ({
			code,
			roleId: validated.roleId,
			count: 1,
			userId,
			expireTime: validated.expireTime,
			userValidity
		}));

		await orm(c).insert(regKey).values(rows).run();
		return Array.from(codes);
	},

	validateUserValidity(userValidity = userConst.validity.YEAR) {
		const allowed = [
			userConst.validity.WEEK,
			userConst.validity.MONTH,
			userConst.validity.YEAR,
			userConst.validity.PERMANENT
		];
		if (!allowed.includes(userValidity)) {
			throw new BizError(t('invalidValidityType'));
		}
		return userValidity;
	},

	async validateRoleAndExpireTime(c, roleId, expireTime) {
		if (!expireTime) {
			throw new BizError(t('emptyRegKeyExpire'));
		}

		roleId = Number(roleId);
		const roleRow = await roleService.selectById(c, roleId);
		if (!roleRow) {
			throw new BizError(t('roleNotExist'));
		}

		return {
			roleId,
			expireTime: formatDetailDate(expireTime)
		};
	},

	generateCode() {
		const randomValues = new Uint8Array(REG_KEY_LENGTH);
		crypto.getRandomValues(randomValues);
		return Array.from(
			randomValues,
			value => REG_KEY_CHARS[value % REG_KEY_CHARS.length]
		).join('');
	},

	async delete(c, params) {
		let {regKeyIds} = params;
		regKeyIds = regKeyIds.split(',').map(id => Number(id));
		await orm(c).delete(regKey).where(inArray(regKey.regKeyId,regKeyIds)).run();
	},

	async clearNotUse(c) {
		let now = formatDetailDate(toUtc().tz('Asia/Shanghai').startOf('day'))
		await orm(c).delete(regKey).where(or(eq(regKey.count, 0),sql`datetime(${regKey.expireTime}, '+8 hours') < datetime(${now})`)).run();
	},

	selectByCode(c, code) {
		return orm(c).select().from(regKey).where(eq(regKey.code, code)).get();
	},

	async validateForAccountAdd(c, code) {
		const regKeyRow = await this.selectByCode(c, code);

		if (!regKeyRow) {
			throw new BizError(t('notExistRegKey'));
		}

		if (regKeyRow.count <= 0) {
			throw new BizError(t('noRegKeyTotal'));
		}

		const today = toUtc().tz('Asia/Shanghai').startOf('day');
		const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');

		if (expireTime.isBefore(today)) {
			throw new BizError(t('regKeyExpire'));
		}

		const defaultRole = await roleService.selectDefaultRole(c);

		if (!defaultRole || regKeyRow.roleId !== defaultRole.roleId) {
			throw new BizError(t('accountRegKeyDefaultRoleOnly'));
		}

		return regKeyRow;
	},

	async list(c, params) {

		const {code} = params
		let query = orm(c).select().from(regKey)

		if (code) {
			query = query.where(like(regKey.code, `${code}%`))
		}

		const regKeyList = await query.orderBy(desc(regKey.regKeyId)).all();
		const roleList = await roleService.roleSelectUse(c);

		const today = toUtc().tz('Asia/Shanghai').startOf('day')

		regKeyList.forEach(regKeyRow => {

			const index = roleList.findIndex(roleRow => roleRow.roleId === regKeyRow.roleId)
			regKeyRow.roleName = index > -1 ? roleList[index].name : ''

			const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');

			if (expireTime.isBefore(today)) {
				regKeyRow.expireTime = null
			}
		})

		return regKeyList;
	},

	async reduceCount(c, code, count) {
		const result = await orm(c).update(regKey).set({
			count: sql`${regKey.count}
	  -
	  ${count}`
		}).where(and(
			eq(regKey.code, code),
			gte(regKey.count, count)
		)).run();
		return (result.meta?.changes ?? result.changes ?? 0) > 0;
	},

	async increaseCount(c, code, count) {
		await orm(c).update(regKey).set({
			count: sql`${regKey.count}
	  +
	  ${count}`
		}).where(eq(regKey.code, code)).run();
	},

	async history(c, params) {
		const { regKeyId } = params;
		return userService.listByRegKeyId(c, regKeyId);
	}
}

export default regKeyService;
