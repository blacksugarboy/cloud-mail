# 2026-09-04 上游同步说明

本次同步上游 `maillab/cloud-mail` 的 `main`，目标提交为 `57a4b1f`（2026-08-29，`feat: add webhook`）。合并后版本为 3.2.0。

## 历史衔接

上游重写了 Git 历史。本仓库原始基线 `a6b66fc` 与新上游基线 `5c8c8a6` 的文件树均为 `e9cfaff6d46a2ec90c4706b72cc34347b1c6154b`，源码完全一致。

先以保留本地文件的合并提交连接该等价基线，再正常三方合并其后的 34 个上游提交。没有重写本仓库原有提交；后续可通过 `upstream` 远端进行普通合并。

## 功能整合

- 接入上游 OAuth（LinuxDo、GitHub、Google）、Plus Address、Webhook、自动清理、同步删除、列表查询与索引优化及界面改进。
- 保留 Workers AI 移除及历史字段清理，不恢复 AI 绑定、验证码识别或相关查询字段。
- 保留批量一次性注册码、单码多次使用、用户有效期与编辑权限、多号模式及角色邮箱限额。
- 保留用户列表有效期展示及有效期弹窗布局修正。
- 将本仓库的有效期迁移独立为 `customUserValidityDB`，避免与上游同名版本迁移互相覆盖。
- OAuth 用户按平台和外部用户 ID 联合查询；旧 LinuxDo 数据自动补全平台，避免与其他平台相同 ID 误关联。
- 同步删除默认关闭，延续原有软删除行为。管理员明确开启后，邮件和邮箱删除才会使用上游新增的永久删除逻辑。

## 部署注意

本次只进行本地代码合并、构建和隔离测试，没有推送、部署或访问生产数据库。

1. 部署前备份 D1 数据库。
2. 部署后执行 `/api/init/<JWT_SECRET>`，响应应为 `success`；现有 GitHub Actions 部署流程包含该步骤。初始化会添加新配置和索引，保留已设置的有效期，空有效期用户设为永久，超级管理员保持永久。
3. OAuth 配置现由系统设置管理。首次升级时，如果 Worker 仍保留旧 `linuxdo_client_id`、`linuxdo_client_secret` 和 `linuxdo_switch` 环境变量，将导入数据库；重复初始化不会覆盖后台设置。未保留这些环境变量时，请在系统设置重新填写。
4. OAuth 平台回调地址应配置为本站的 `/login`。自动清理和 Webhook 默认不启用，请按需配置。

## 本地验证

前端目录执行 `npm run build`；Worker 目录执行：

```sh
npm run test:regression
npx --no-install wrangler deploy --dry-run --config wrangler-dev.toml
```

回归测试使用独立、临时的本地 D1/KV，覆盖新建/升级/重复初始化、注册码、有效期和权限、OAuth 平台隔离与注册绑定、多号和 Plus Address、无 AI 邮件列表、已读状态、删除策略、自动清理及模拟 Webhook。

现有 Workers 测试依赖内置的运行时较旧，测试时会提示兼容日期从 2025-06-04 回退到 2025-03-10；生产配置未改动。Worker 打包另外使用项目的 Wrangler 4.90.0 检查。OAuth 第三方真实授权、实际投递及生产部署仍需在部署环境验收。
