# 接口文档解析规范

## 目录

- [概述](#概述)
- [接口文档格式](#接口文档格式)
- [公共结构文档格式](#公共结构文档格式)
- [解析算法](#解析算法)
  - [Step 1: 解析表格](#step-1-解析表格)
  - [Step 2: 构建 Element 定义表](#step-2-构建-element-定义表)
  - [Step 3: 构建字段路径映射](#step-3-构建字段路径映射)
  - [Step 4: 查找字段定义](#step-4-查找字段定义)
  - [Step 5: 输出映射表](#step-5-输出映射表)
- [变量名映射逻辑](#变量名映射逻辑)
- [特殊情况处理](#特殊情况处理)
  - [nosend 和 nocare](#nosend-和-nocare)
  - [字面值](#字面值)
  - [嵌套 _text](#嵌套-_text)

## 概述

接口字段文档（MD 格式）和公共结构文档（MD 格式）用于建立"变量名 → 接口字段路径 → 字段定义"的映射表（Rosetta Stone），解决历史用例变量名与步骤资产变量名不一致的问题。

## 接口文档格式

接口文档是 Markdown 表格，格式如下：

```markdown
# 余额和免费资源调账接口

## 请求消息 AdjustmentRequestMsg

**表1 Element AdjustmentRequestMsg**

| 参数 | 数据类型 | 参数描述 |
| --- | --- | --- |
| RequestHeader | RequestHeader | 请求头。 |
| AdjustmentRequest | AdjustmentRequest | 调账请求。 |

**表2 Element AdjustmentRequest**

| 参数 | 数据类型 | 参数描述 |
| --- | --- | --- |
| AdjustmentObj | AdjustmentObj | 调账对象。 |
| OpType | String(1) | 操作类型。1：新增2：修改3：删除 |
| AdjustmentInfo | AdjustmentInfo | 调账信息。 |
| FreeUnitAdjustmentInfo | FreeUnitAdjustmentInfo | 免费资源调账信息。 |
| AdjustmentReasonCode | String(64) | 调账原因码。 |
```

## 公共结构文档格式

公共结构文档定义了被多个接口引用的公共 Element：

```markdown
**表3 Element CustAccessCode**

| 参数 | 数据类型 | 参数描述 |
| --- | --- | --- |
| CustomerKey | CustKey | 外部客户键值。 |
| CustomerCode | String(32) | 客户编码。 |
```

## 解析算法

### Step 1: 解析表格

逐行扫描 Markdown，识别表格块：
- 表格以 `|` 开头的行组成
- 表头行：`| 参数 | 数据类型 | 参数描述 |`
- 分隔行：`| --- | --- | --- |`
- 数据行：`| FieldName | Type | Description |`

表头列识别支持中英文：
- 参数名列：匹配 `参数`、`name`、`element`、`字段`
- 数据类型列：匹配 `数据类型`、`类型`、`type`、`data type`
- 描述列：匹配 `参数描述`、`描述`、`说明`、`description`、`desc`、`meaning`、`remark`
- 路径列（可选）：匹配 `路径`、`path`、`xpath`、`node`

每个表格前通常有 `**表N Element XxxName**` 标题，用于识别该表格定义的是哪个 Element。解析器同时识别 `# 标题` 和 `**表N ElementName**` 两种格式作为当前接口/Element 名称。

当表格没有路径列时，参数名同时用作 path 值。

### Step 2: 构建 Element 定义表

```
ElementName → {
  fields: {
    FieldName: {
      type: string,        // 数据类型（如 String(32), Amount, CustKey）
      description: string, // 字段描述
      optional: boolean,   // 是否可选（参数名包含 (optional)）
      is_reference: boolean, // 数据类型是否引用了另一个 Element
      reference_name: string // 引用的 Element 名称
    }
  }
}
```

### Step 3: 构建字段路径映射

从 SoapClient 的 rReq JSON 中提取字段路径：

```
rReq = {
  "AdjustmentRequestMsg": {
    "AdjustmentRequest": {
      "AdjustmentInfo": {
        "AdjustmentType": "${My_AdjustmentType}",
        "AdjustmentAmt": "${My_AdjAmt}"
      }
    }
  }
}
```

递归遍历 rReq，对每个叶子节点：
- 如果值是 `${VarName}`：记录 `VarName → field_path`
- field_path 格式：`AdjustmentRequestMsg.AdjustmentRequest.AdjustmentInfo.AdjustmentType`

### Step 4: 查找字段定义

用 field_path 的最后一段（字段名）在 Element 定义表中查找：
1. 先在接口文档的 Element 中查找
2. 如果字段的 type 是引用（如 `AdjustmentInfo`），递归展开公共结构
3. 如果在公共结构文档中找到匹配的 Element 定义，合并字段

### Step 5: 输出映射表

```typescript
interface FieldMapping {
  variable_name: string;        // 变量名（如 My_AdjAmt）
  field_path: string;           // 字段路径（如 AdjustmentRequest.AdjustmentInfo.AdjustmentAmt）
  field_name: string;           // 字段名（如 AdjustmentAmt）
  data_type: string;            // 数据类型（如 Amount）
  description: string;          // 字段描述
  element_name: string;         // 所属 Element
  optional: boolean;            // 是否可选
}
```

## 变量名映射逻辑

当历史用例的变量名与步骤资产的变量名不一致时：

1. 提取双方的 SoapClient rReq 字段路径
2. 找到字段路径相同的变量对
3. 例如：
   - 步骤资产：`My_AdjAmt → AdjustmentRequest.AdjustmentInfo.AdjustmentAmt`
   - 历史用例：`My_Amount → AdjustmentRequest.AdjustmentInfo.AdjustmentAmt`
   - 结论：`My_AdjAmt ≡ My_Amount`（同一字段的不同变量名）

4. 建立等价变量名映射表，用于参数签名匹配和 Delta 计算

## 特殊情况处理

### nosend 和 nocare

- 值为 `"nosend"`：该字段不发送，不参与匹配
- 值为 `"nocare"`：响应该字段不校验，不参与匹配
- 值为 `"ignored"`：忽略

### 字面值

如果 rReq 中某字段直接是字面值（如 `"OpType": "1"`），不是变量引用：
- 记录字段路径和字面值
- 用于 Delta 计算中的"修改默认值"检测

### 嵌套 _text

某些字段有 `_text` 子节点：
- `_text: "nosend"` 表示该节点的文本内容不发送
- `_text: "nocare"` 表示响应中该节点的文本内容不校验
