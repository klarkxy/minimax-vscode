# VS Code Marketplace 上架进度

> 本扩展**尚未**上架 VS Code 官方市场,目前在 **Open VSX** + **GitHub Releases** 双渠道分发。
> 本文件跟踪 Microsoft Marketplace 的恢复进度,以及用户在过渡期如何安装。

## 现状

| 渠道 | 状态 | 用户体验 |
| --- | --- | --- |
| Open VSX | ✅ **已发布** | 见下方"用户安装指南" |
| GitHub Releases | ✅ **自动发布** | 每次 release 自动附 `.vsix` |
| VS Code Marketplace | ❌ **未发布** | 等原 Azure DevOps 租户恢复后即可上架 |

## 为什么没在 Marketplace

`publisher: "klarkxy"` 对应的 Microsoft / Azure DevOps 租户(`f8cdef31-a31e-4b4a-93e4-5f571e91255a`)因长期不活动被 Microsoft 自动锁定(`AADSTS5000225`),无法登录 `marketplace.visualstudio.com` 创建新的 `klarkxy` publisher,也无法签发 PAT。

详细解释见根目录 `package.json` 里的 `publisher` 字段、CI workflow `.github/workflows/release.yml` 的 `if: vars.PUBLISH_VSCODE_MARKETPLACE != 'false'` 条件,以及 `README.md` 顶部的"Distribution status"段落。

## 用户安装指南(过渡期)

### 方法 1:从 Open VSX 网页下载 `.vsix` (推荐 ✅)

1. 打开 https://open-vsx.org/extension/klarkxy/minimax-vscode
2. 找到右上角 **"Download"** 按钮,点一下下载 `klarkxy.minimax-vscode-x.y.z.vsix`
3. 在 VS Code 里按 `Ctrl+Shift+P` → 输入 **"Extensions: Install from VSIX..."** → 选下载的文件 → 安装完成

> 缺点:无自动更新提示,每次升级需要重复以上步骤。

### 方法 2:从 GitHub Releases 下载 `.vsix`

1. 打开 https://github.com/zelosleone/minimax-vscode/releases
2. 下载最新 release 的 `*.vsix` 附件
3. 同样 `Ctrl+Shift+P` → **"Extensions: Install from VSIX..."** 安装

### 方法 3:用 VSCodium / Gitpod / Eclipse Theia(原生支持 Open VSX)

这些编辑器默认就搜 Open VSX,直接搜 "MiniMax Copilot" 即可一键装,且有自动更新。

## 恢复 Marketplace 的 Checklist

- [ ] 每天尝试一次 https://dev.azure.com 登录,看 `AADSTS5000225` 是否解除
- [ ] 提交 Microsoft 支持工单,请求恢复租户 (见 https://learn.microsoft.com/en-us/entra/fundamentals/inaccessible-tenant)
- [ ] 一旦恢复:
  1. 在 [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) 重新登录 `klarkxy` 账号
  2. 头像 → Personal access tokens → New Token (All orgs + Marketplace: Manage)
  3. 在 GitHub repo 的 `Settings → Secrets and variables → Actions` 添加 `VSCE_PAT`
  4. 删除/编辑 `PUBLISH_VSCODE_MARKETPLACE=false` 这个 variable(或改回 `true`)
  5. 下一次 push main,release-please 会自动触发双发到 Marketplace + Open VSX

## 防再次被锁(永久)

参考 [Microsoft Entra 不可访问租户](https://learn.microsoft.com/en-us/entra/fundamentals/inaccessible-tenant) 文档,推荐:

- [ ] 在 `entra.microsoft.com → Properties → Notification emails` 加一个**长期邮箱**(Gmail / 工作邮箱)
- [ ] 给租户挂一个**免费 Azure 订阅** (租户被标 active 后,不会被 inactivity 政策锁)
- [ ] 每年至少登录一次 `dev.azure.com` / `portal.azure.com`

## 临时配置(给维护者看)

`release.yml` 里的 `vsce publish` 步骤**默认会被 skip**,因为现在没 `VSCE_PAT` secret。控制开关是 repo 里的 **Variable** `PUBLISH_VSCODE_MARKETPLACE`(默认 `true`,想临时关闭设为 `false`)。
