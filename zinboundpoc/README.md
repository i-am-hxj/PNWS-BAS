# 生产完工入库单管理 · SAPUI5 Freestyle 前端

SAP ABAP Cloud RAP 服务 `ZSB_INBZB_O2`（OData V2）的前端应用：入库单列表查询、新建、明细维护、删除、A4 单据打印。

| 项 | 值 |
|---|---|
| 应用 ID | `panawin.zinbound` |
| UI5 版本 | 1.120.x（`https://sdk.openui5.org/1.120.40/resources/sap-ui-core.js`，CDN 加载） |
| 模型 | `sap.ui.model.odata.v2.ODataModel`（`useBatch: true`，默认绑定 `TwoWay`，批处理组 `changes`） |
| 服务根路径 | `/sap/opu/odata/sap/ZSB_INBZB_O2/` |
| 依赖 | 只用标准 `sap.m` / `sap.ui.layout` / `sap.ui.core` / `sap.ui.model.odata.v2`，无第三方库、无 TypeScript、无编译步骤 |
| 界面语言 | 简体中文（`webapp/i18n/i18n.properties`，UTF-8） |

---

## 1. 目录结构

```
ui/
├── package.json                     # 脚本与（仅部署用的）依赖声明
├── ui5.yaml                         # UI5 Tooling：ui5 serve / ui5 build
├── mta.yaml                         # BTP CF 部署描述（html5 + approuter + destination）
├── xs-app.json                      # approuter 路由：/sap/opu/odata/ -> destination
├── xs-security.json                 # approuter 的 XSUAA 安全描述
├── README.md
└── webapp/
    ├── index.html                   # sap-ui-bootstrap，ComponentSupport 声明式启动
    ├── manifest.json                # 应用描述：dataSource / models / routing
    ├── Component.js                 # Mock 启动 + 值帮助加载 + 路由初始化
    ├── i18n/i18n.properties         # 全部界面文本
    ├── css/style.css
    ├── view/
    │   ├── App.view.xml             # sap.m.App（路由把页面加入 pages）
    │   ├── List.view.xml            # 列表页
    │   ├── Detail.view.xml          # 明细页（SimpleForm + Table）
    │   └── CreateDialog.fragment.xml# 新建对话框（只收集抬头）
    ├── controller/
    │   ├── App.controller.js        # 浏览器标题同步
    │   ├── List.controller.js       # 查询/筛选/排序/新建/删除/打印
    │   └── Detail.controller.js     # 抬头+明细维护、校验、保存、打印
    ├── util/
    │   ├── Formatter.js             # 视图 formatter（3 位小数、空值 "-"、值帮助文本）
    │   └── PrintUtil.js             # A4 单据 HTML 生成 + window.open/document.write/print
    └── localService/
        ├── metadata.xml             # 本地 OData V2 元数据（与 RAP 后端一致）
        ├── mockserver.js            # sap.ui.core.util.MockServer 封装
        └── mockdata/*.json          # 3 张抬头 + 8 条明细 + 6 个值帮助集合
```

## 2. 本地预览

### 2.1 零安装（推荐，仅需一个静态服务器）

`index.html` 从 CDN 引导 UI5，**不需要 `npm install`**。任意静态服务器指向 `ui/webapp` 即可，例如：

```powershell
# 方式 A：Python 内置静态服务器（本机 python.exe 路径见下）
C:\Users\Administrator\dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe -m http.server 8080 --directory ui\webapp

# 方式 B：Node 一行 HTTP 服务器 / 任意 Web Server（IIS、nginx…）
```

浏览器打开：

| 地址 | 说明 |
|---|---|
| `http://localhost:8080/index.html?mock=true` | **Mock 模式**：使用 `localService/` 下的元数据与 mockdata，不访问后端 |
| `http://localhost:8080/index.html` | 真实模式：请求 `/sap/opu/odata/sap/ZSB_INBZB_O2/`（需本地有 approuter/反向代理） |

### 2.2 使用 UI5 Tooling（可选）

```powershell
npm install          # 只有这一步需要网络/npm
npm run start        # ui5 serve --open "index.html?mock=true"
npm run build        # ui5 build --all --dest dist
```

Mock 模式只需要 `webapp/localService/`，与 `ui5 serve` 无关；两者可任选。

## 3. Mock 实现说明（`webapp/localService/mockserver.js`）

* 使用 `sap.ui.core.util.MockServer`，`rootUri = /sap/opu/odata/sap/ZSB_INBZB_O2/`，
  通过 `simulate("localService/metadata.xml", {sMockdataBaseUrl: "localService/mockdata/"})` 加载元数据与 mockdata，
  再由 `start()` 用 sinon 接管 XHR。
* **CRUD**：GET / POST / MERGE / DELETE / `$batch` / `$metadata` 由 MockServer 默认处理器完成。
* **`$expand=_Items`**：MockServer **原生支持**（`_getOdataQueryExpand` + `_resolveNavigation`），
  依赖元数据里的 `NavigationProperty + Association + ReferentialConstraint + AssociationSet`，
  并由 `_enhanceWithMetadata` 为每条记录补出 `_Items` 的 `__deferred` 链接。
  因此**不需要手工拼接 JSON**；`metadata.xml` 里的关联定义是 $expand 能否工作的前提。
* **新建抬头（后端生成主键）**：默认 POST 只会回显请求体，无法模拟"服务端生成 InboundNo"。
  因此追加了一个自定义 POST 处理器（注册在默认处理器**之后** —— sinon 逆序匹配，后注册者优先）：
  1. 解析请求体，忽略前端可能提交的 `InboundNo`/合计字段；
  2. 按规则 `IN + yyyyMMdd + 4 位流水` 生成主键（如 `IN202610200001`）；
  3. 补齐后端计算字段（`TotalItems=0`、`TotalLength/TotalWeight="0.000"`、`CreatedBy="MOCKUSER"`）；
  4. 写入 mock 数据集（后续 GET 可见），返回 `201` + `Location` + `{"d": {...}}`。
* **后端计算字段**：通过 `attachAfter("GET", …, "InboundHeader")` 在响应发出前按明细重算
  `TotalItems / TotalLength / TotalWeight`（集合请求用 `oFilteredData`，单实体请求用 `oEntry`），
  让 Mock 环境的合计与明细始终自洽。
* Mock 数据：3 张抬头（`IN202610200001`、`IN202610200002`、`IN202610210001`），
  各 2~3 条明细，合计与明细一致；6 个值帮助集合见 `mockdata/*.json`。

## 4. 关键设计决策

1. **新建是两步提交**：`CreateDialog` 只收集抬头必填/可选字段 →
   `createEntry("/InboundHeader", {properties, groupId:"changes"})` → 单独 `submitChanges()`
   → 从 `createEntry.success` / 创建上下文 / `__batchResponses` 三个来源取出真实 `InboundNo`
   → `navTo("detail", {inboundNo})` 再录明细。**抬头与明细绝不在同一个 batch 里创建**，
   因为明细的 `InboundNo` 依赖后端生成的抬头主键。
2. **`InboundNo` 前端不可编辑**：新建时不提交该字段；明细页以只读文本展示。
   `TotalItems / TotalLength / TotalWeight / CreatedBy` 同样只读（展示后端计算结果）。
3. **行号由前端分配**：`增加行` 时取"当前明细 + 待删除明细"的最大数字行号 + 10，
   格式化为 6 位（`000010`、`000020`…）；把待删除行计入最大值可避免"删了最后一行再加一行"
   导致同一个 `ItemNo` 同时出现 POST 与 DELETE。
4. **明细页使用 JSONModel("detail") 作为工作表**：
   `read()` + `$expand=_Items` 之后把抬头/明细复制进 JSONModel 编辑，
   这样新增行在保存前就能显示（OData V2 的 `createEntry` 不会把新行插入到 `_Items` 绑定里）。
   保存时再用模型 API 提交：
   * 抬头/行修改：`oModel.update(path, oChanged, {groupId:"changes", eTag})`（只提交变化的字段）
   * 行新增：`oModel.createEntry("/InboundItem", {properties:{InboundNo, ItemNo, …}, groupId:"changes"})`
   * 行删除：`oModel.remove(itemPath, {groupId:"changes", eTag:"*"})`
   * 最后统一 `oModel.submitChanges({groupId:"changes"})`（一个 change set，一次批量请求）
   * 取消：`resetChanges()` 后返回列表
   > 说明：这里没有对实体 key 路径做 `setProperty`。`$expand` 出来的明细在 V2 模型缓存中
   > 没有独立的实体 key 路径，对这类路径 `setProperty` 不会登记脏实体，`submitChanges` 会静默丢改动；
   > 而 `update/remove` 是 V2 官方支持的"无上下文写接口"，语义等价且不依赖缓存状态。
5. **ETag**：`_fillModel` 保存 `__metadata.etag`（抬头 → `header._etag`，明细 → `item._etag`），
   修改时作为 `If-Match` 传入；Mock/无 ETag 时退化为 `"*"`（见"已知限制"）。
6. **删除顺序**：列表页多选删除时，先读 `$expand=_Items` 拿到全部明细键 →
   `remove` 明细 → `submitChanges` → `remove` 抬头 → `submitChanges`（顺序提交，规避外键约束）。
7. **搜索/排序**：`SearchField` 对 `InboundNo/WorkOrder/WorkCenter/ProdLine/Team/Warehouse/MesNo/Remark/CreatedBy`
   生成 `substringof` 的 OR 过滤（`oListBinding.filter`，走 `$filter`；MockServer 支持 `substringof(...)`）；
   排序用工具栏 `Select + ToggleButton` → `oListBinding.sort(new Sorter(field, desc))`（`$orderby`）。
8. **打印**：`util/PrintUtil.js` 生成完整 A4 HTML（内联 `<style>`、`@page { size: A4; margin: 12mm }`、
   `Microsoft YaHei, SimSun`），`window.open` + `document.write` + `print()`；
   所有动态内容经 `escapeHtml()` 转义（防注入）；弹窗被拦截时 `MessageBox.error` 提示。
   列表页多选打印时，多张单据写入**同一个**打印窗口、每张单独一页（避免连续 `window.open` 被拦截）。

## 5. 部署到 BTP（Cloud Foundry）

> 完整路线（架构、前置条件、认证模式、8 步操作、排错、成本）见 **docs/10-BTP部署指南.md**。


```powershell
npm install
npx mta build --platform CF
cf deploy mta_archives/zinbound_1.0.0.mtar
```

* `zinbound-app-content`（type `html5`）：构建产物推送到 `html5-apps-repo`（app-host）。
* `zinbound-approuter`（`@sap/approuter`）：托管静态资源并转发 OData。
* `zinbound-destination-service`：destination 名称 `zinbound-odata`，URL 覆盖后端
  `/sap/opu/odata/`（部署前把 `mta.yaml` 里的 `<abap-cloud-host>` 换成真实主机名；
  生产环境建议把 `Authentication` 改成 `OAuth2SAMLBearerAssertion` 或 `PrincipalPropagation`）。
* `xs-app.json`：`^/sap/opu/odata/(.*)$` → `destination: zinbound-odata`，其余走 `html5-apps-repo-rt`。
* 前端 `manifest.json` 里的 `mainService.uri` 保持相对路径 `/sap/opu/odata/sap/ZSB_INBZB_O2/`，
  因此 destination 只需覆盖 `/sap/opu/odata/` 这一级。

## 6. 后端契约（与 `localService/metadata.xml` 一致）

| EntitySet | 键 | 说明 |
|---|---|---|
| `InboundHeader` | `InboundNo` (Edm.String 16) | 抬头；`_Items` 为 1..* 导航到 `InboundItem` |
| `InboundItem` | `InboundNo` + `ItemNo` (Edm.String 6) | 明细；`ItemNo` 形如 `000010` |
| `WorkCenterVH` / `ProdLineVH` / `TeamVH` / `WarehouseVH` / `StorageBinVH` / `CoilTypeVH` | 编码 | 只读值帮助，启动时一次性 `read()` 进 JSONModel `"vh"`，绑定到 `sap.m.ComboBox`（不依赖 VH 注解） |

字段与中文标签见 `webapp/localService/metadata.xml`（`sap:label`）。

## 7. 已知限制

1. **CDN 版本**：`sdk.openui5.org` 只保留部分 1.120 补丁版本，`1.120.0` 实测已 404，
   因此 `index.html` 已固定为 **1.120.40**（实测 200）。若该补丁版日后也被回收，
   换成同维护线的其它补丁版（如 `1.120.39`）或 `ui5.sap.com` 的同名路径即可，代码无需改动。
2. **ETag / 乐观锁**：Mock 数据没有 `__metadata.etag`，删除固定使用 `eTag: "*"`，修改在取不到 ETag 时也退化为 `"*"`，
   即"后写覆盖"。真实 RAP 服务（BDEF 启用 ETag）会在 `read` 响应里返回 `__metadata.etag`，
   代码已透传（抬头/明细分别保存），需要严格并发控制时依赖该值即可；若需求要求"无 ETag 即拒绝保存"，
   可在 `Detail.controller._updateEntity` 里把 `sETag || "*"` 改成抛错。
3. **Mock 只模拟到接口层**：不校验字段长度/域值、不做权限检查，也不实现真实的流水号并发（按当前最大流水 +1）。
4. **打印**：浏览器自带的页眉页脚无法用 CSS 关闭，需在打印对话框中取消勾选（页面已通过 `@page` 设置 A4 + 12mm 页边距）。
   多张单据共用一个打印窗口，每张单据的页脚固定为"第 1 页 / 共 1 页"（每张单据自身就是一页）。
5. **列表页未分页**：`growing` 关闭、`defaultCountMode: "None"`；数据量很大时应改为 `$top/$skip` 或服务端分页。
6. `Delete` 后不清理 Model 缓存中的孤儿实体；返回列表页会刷新绑定，因此不影响使用。

## 8. 自查（质量门禁）

仓库里已带可复现的校验脚本（在项目根的 `tools/` 下）：

```powershell
$node = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$py   = "C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"

# 1. JS 语法（7 个文件）
Get-ChildItem "E:\SAP\代码开发\ui" -Recurse -Filter *.js | ForEach-Object { & $node --check $_.FullName }

# 2. XML / JSON / i18n 解析 + 交叉引用
#    （manifest 契约、视图↔controller、byId↔XML id、事件处理器、formatter、绑定属性↔metadata）
& $py "E:\SAP\代码开发\tools\check_ui.py"

# 3. 打印输出功能测试（Node 里加载 Formatter/PrintUtil 生成 HTML 并断言）
& $node "E:\SAP\代码开发\tools\test_print.js"
```

当前结果：`node --check` 7/7 通过；`check_ui.py` 报告 0 个交叉引用问题；
`test_print.js` 16 条断言全部通过（含 HTML 转义防注入、A4 规则、9 列明细、合计自洽）。
打印版式的实际渲染效果见 `../docs/preview/打印预览.png`。
