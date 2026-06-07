# 第三章：Security & RBAC

## 整體安全架構

```
外部請求
    │
    ▼
┌─────────────────────────────────────────────────┐
│  1. Authentication（你是誰？）                    │
│     - X.509 憑證（kubectl）                      │
│     - ServiceAccount Token（Pod 內部）           │
│     - OIDC（整合 SSO）                           │
└─────────────────────────────────────────────────┘
    │ 通過
    ▼
┌─────────────────────────────────────────────────┐
│  2. Authorization（你能做什麼？）                  │
│     - RBAC：Role / ClusterRole                  │
│     - RoleBinding / ClusterRoleBinding          │
└─────────────────────────────────────────────────┘
    │ 通過
    ▼
┌─────────────────────────────────────────────────┐
│  3. Admission Control（操作合不合規？）            │
│     - MutatingAdmissionWebhook（自動修改資源）    │
│     - ValidatingAdmissionWebhook（驗證並拒絕）   │
│     - OPA / Gatekeeper / Kyverno               │
└─────────────────────────────────────────────────┘
    │ 通過
    ▼
  etcd（寫入）
```

---

## Authentication（認證）

### kubectl 用什麼認證？

kubectl 透過 `~/.kube/config` 裡的憑證（X.509 Client Certificate）向 API Server 認證：

```yaml
users:
- name: my-user
  user:
    client-certificate: /path/to/cert.crt
    client-key: /path/to/key.key
```

憑證裡的 `CN`（Common Name）是使用者名稱，`O`（Organization）是群組名稱，RBAC 用這兩個做授權。

### Pod 用什麼認證？

Pod 預設掛載 **ServiceAccount Token**（JWT），位置在：

```
/var/run/secrets/kubernetes.io/serviceaccount/token
```

Pod 透過這個 token 對 API Server 發請求，API Server 驗證 token 後知道這個 Pod 的身份。

### OIDC 整合（企業環境）

```
使用者 → OIDC Provider（Google、Okta、Dex）
          → 拿到 JWT ID Token
          → 帶著 token 打 API Server
          → API Server 驗證 token 簽章
```

---

## ServiceAccount

每個 Pod 都有一個 ServiceAccount（預設是 `default`），代表這個 Pod 在 cluster 內的身份。

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-app-sa
  namespace: production
```

### 指定 ServiceAccount 給 Pod

```yaml
apiVersion: v1
kind: Pod
spec:
  serviceAccountName: my-app-sa
  containers:
    - name: app
      image: my-app:latest
```

### 停用自動掛載 Token

如果 Pod 不需要存取 API Server，應該停用（最小權限原則）：

```yaml
spec:
  automountServiceAccountToken: false
```

---

## RBAC 核心概念

RBAC（Role-Based Access Control）是 k8s 預設的授權機制，四個核心物件：

```
Who（Subject）  +  What（Role）  =  RoleBinding
────────────────────────────────────────────────
User / Group /      允許做什麼操作       把 who 和 what 綁在一起
ServiceAccount      對哪些資源
```

### Role vs ClusterRole

| | Role | ClusterRole |
|--|------|-------------|
| 作用範圍 | 單一 Namespace | 整個 Cluster |
| 常見用途 | 應用程式權限 | 管理員、跨 Namespace 操作 |

### 範例：建立 Role

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: production
rules:
  - apiGroups: [""]           # "" 代表 core API group
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list"]
```

### 範例：RoleBinding

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
  namespace: production
subjects:
  - kind: User
    name: alice
    apiGroup: rbac.authorization.k8s.io
  - kind: ServiceAccount
    name: my-app-sa
    namespace: production
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

### 常用 Verbs 對照

| Verb | HTTP 方法 | 說明 |
|------|-----------|------|
| `get` | GET | 讀取單一資源 |
| `list` | GET | 列出資源 |
| `watch` | GET + watch | 監聽資源變化 |
| `create` | POST | 建立資源 |
| `update` | PUT | 完整更新 |
| `patch` | PATCH | 部分更新 |
| `delete` | DELETE | 刪除資源 |
| `*` | 所有 | 所有操作（給管理員用） |

### ClusterRole：常見的內建角色

| ClusterRole | 說明 |
|-------------|------|
| `cluster-admin` | 最高權限，等同 root |
| `admin` | 可管理 namespace 內大部分資源 |
| `edit` | 可讀寫大部分資源，不能改 RBAC |
| `view` | 只能讀取，不能修改 |

---

## 驗證 RBAC 設定

```bash
# 確認某個 user 能不能做某件事
kubectl auth can-i get pods --as=alice -n production

# 確認 ServiceAccount 的權限
kubectl auth can-i list secrets \
  --as=system:serviceaccount:production:my-app-sa

# 列出某個 SA 的所有權限
kubectl auth can-i --list \
  --as=system:serviceaccount:production:my-app-sa
```

---

## Pod Security

### Pod Security Admission（PSA）

k8s 1.25+ 內建的 Pod 安全管控，在 Namespace 層級設定安全等級：

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: production
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/audit: restricted
```

### 三個安全等級

| 等級 | 說明 | 限制 |
|------|------|------|
| `privileged` | 完全開放 | 無限制 |
| `baseline` | 防止已知危險配置 | 禁止 hostNetwork、privileged container 等 |
| `restricted` | 最嚴格，符合最佳實踐 | 要求 non-root、drop capabilities 等 |

### 限制 Container 安全設定

```yaml
spec:
  securityContext:
    runAsNonRoot: true          # 不能用 root 跑
    runAsUser: 1000
    fsGroup: 2000
  containers:
    - name: app
      securityContext:
        allowPrivilegeEscalation: false   # 禁止提權
        readOnlyRootFilesystem: true      # 根目錄唯讀
        capabilities:
          drop:
            - ALL                         # 移除所有 Linux capabilities
          add:
            - NET_BIND_SERVICE            # 只加回必要的
```

---

## Admission Controller 比較

| | OPA/Gatekeeper | Kyverno | Pod Security Admission |
|--|---------------|---------|----------------------|
| **語言** | Rego | YAML | 內建，無需 YAML |
| **學習曲線** | 高（Rego 語法獨特） | 低（直接寫 YAML 規則） | 無（直接加 label） |
| **靈活性** | 最高 | 高 | 低（只有 3 個等級） |
| **Mutating** | ✅ | ✅ | ❌ |
| **Validating** | ✅ | ✅ | ✅ |
| **生成資源** | ❌ | ✅（ClusterPolicy generate） | ❌ |
| **適合場景** | 複雜自訂規則 | 多數中型企業 | 快速加基礎安全 |

---

## Secrets 管理

### 基本使用

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
type: Opaque
data:
  username: YWRtaW4=   # base64 encoded
  password: cGFzc3dvcmQ=
```

!!! warning "Secret 不等於加密"
    k8s Secret 預設只是 base64 編碼，存在 etcd 裡是明文（除非開啟 encryption at rest）。不要誤以為 Secret 是加密的。

### 掛載 Secret 到 Pod

```yaml
# 方式一：環境變數
env:
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: db-credentials
        key: password

# 方式二：掛載成檔案（更安全，不會出現在 env 列表）
volumeMounts:
  - name: secret-vol
    mountPath: /etc/secrets
    readOnly: true
volumes:
  - name: secret-vol
    secret:
      secretName: db-credentials
```

### Production 建議：External Secrets

不要把機敏資料存在 k8s Secret，改用外部 Secret 管理系統：

- **AWS Secrets Manager** + [External Secrets Operator](https://external-secrets.io/)
- **HashiCorp Vault** + Vault Agent / CSI Driver
- **GCP Secret Manager** / **Azure Key Vault**

```yaml
# External Secrets Operator 範例
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: db-secret
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secretsmanager
    kind: ClusterSecretStore
  target:
    name: db-credentials
  data:
    - secretKey: password
      remoteRef:
        key: prod/db
        property: password
```

---

## Admission Control

Admission Controller 是 API Server 的最後一道關卡，在資源寫入 etcd 前執行。

### Mutating vs Validating

```
Request → Mutating Webhooks → Validating Webhooks → etcd
             （可修改）           （只能允許/拒絕）
```

**常見用途：**

- **Mutating**：自動注入 sidecar（如 Istio envoy）、補全預設值
- **Validating**：強制要求 resource limits、禁止 latest tag、強制 label

### OPA Gatekeeper 範例

```yaml
# 禁止使用 latest tag 的 Policy
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sDisallowedTags
metadata:
  name: container-image-must-not-have-latest-tag
spec:
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Pod"]
  parameters:
    tags: ["latest"]
```

---

## 常見陷阱

!!! warning "default ServiceAccount 權限過大"
    每個 Namespace 的 `default` ServiceAccount 預設沒什麼權限，但有些人會把 `cluster-admin` 綁給它，這非常危險。應該為每個應用建立專屬的 ServiceAccount，只給最小必要權限。

!!! warning "ClusterRoleBinding 範圍太廣"
    用 ClusterRoleBinding 綁定 Role 時，該權限適用於**所有 Namespace**。確認你真的需要跨 Namespace 權限，否則應該用 RoleBinding。

!!! warning "Secret 存敏感資料要加密"
    務必開啟 etcd 的 encryption at rest（`--encryption-provider-config`），否則 Secret 在 etcd 裡是明文，有 etcd 存取權就能看到所有 Secret。

!!! info "RBAC 是 additive（疊加）"
    k8s RBAC 沒有 deny 規則，只有 allow。預設是「拒絕所有」，每條 rule 是在疊加允許清單。無法用 RBAC 來撤銷已有的權限（只能移除 binding）。

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：Role 和 ClusterRole 的差別？什麼時候用 ClusterRole + RoleBinding？
**答案：**

| | Role | ClusterRole |
|--|------|------------|
| 適用範圍 | 單一 Namespace | 整個 Cluster |
| 綁定方式 | RoleBinding（僅該 Namespace） | ClusterRoleBinding（全 Cluster）或 RoleBinding（限定 Namespace）|

**ClusterRole + RoleBinding 的用途：**

一個常見且有用的組合：把 `ClusterRole` 用 `RoleBinding` 綁到特定 Namespace。
- 好處：`ClusterRole` 可以被多個 Namespace 的 `RoleBinding` 重用
- 例如：定義一個 `pod-reader` ClusterRole，然後在不同 Namespace 分別 RoleBinding 給不同用戶

若改成 ClusterRoleBinding，那個用戶就能讀**所有** Namespace 的 Pod，權限過大。
:::

::: details 測驗 2：ServiceAccount 的用途是什麼？Pod 裡的 app 怎麼存取 k8s API？
**答案：**

ServiceAccount 是給**程式（Pod）**用的身份，不是給人用的（人用 User 或 Group）。

k8s 自動：
1. 幫每個 Namespace 建一個 `default` ServiceAccount
2. 把 ServiceAccount Token 掛進 Pod（`/var/run/secrets/kubernetes.io/serviceaccount/token`）
3. Pod 裡的程式用這個 Token 向 API Server 認證

**典型使用場景：**
- Controller/Operator（需要 Watch、建立 k8s 資源）
- Prometheus（需要讀 Pod metrics）
- ArgoCD（需要讀 Git、apply 資源）

**安全最佳實踐：**
- 不要直接用 `default` ServiceAccount（預設沒有什麼權限，但萬一被賦予權限就很危險）
- 為每個 app 建立獨立的 ServiceAccount，只賦予最小必要權限
- 設定 `automountServiceAccountToken: false`（不需要 API 存取的 Pod）
:::

::: details 測驗 3：什麼是 Admission Controller？它和 RBAC 的執行順序？
**答案：**

請求進入 API Server 的完整流程：

```
1. Authentication（我是誰）
2. Authorization / RBAC（我有什麼權限）
3. Admission Control（這個操作合規嗎）
   ├── Mutating Webhook（可以修改請求，如補預設值）
   └── Validating Webhook（只能 approve/deny，不能修改）
4. 寫入 etcd
```

**RBAC 在 Admission 前**：RBAC 先決定你有沒有權限做這個操作，Admission Controller 再決定這個操作是否符合額外的規則。

常用 Admission Controller：
- `LimitRanger`：自動補充 requests/limits 預設值
- `ResourceQuota`：強制 Namespace 資源上限
- `PodSecurity`：限制 Pod 的安全設定（取代舊的 PodSecurityPolicy）
- `MutatingAdmissionWebhook` / `ValidatingAdmissionWebhook`：自訂 Webhook（KubeVirt、Istio 都用這個）
:::

---

## 實作：RBAC 設定

```bash
# === 建立 ServiceAccount 和 RBAC ===
kubectl create namespace dev

# 建立 ServiceAccount
kubectl -n dev create serviceaccount my-app

# 建立 Role（只能讀 pod 和 logs）
kubectl apply -f - <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: dev
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
EOF

# 綁定 ServiceAccount 和 Role
kubectl -n dev create rolebinding my-app-pod-reader \
  --role=pod-reader \
  --serviceaccount=dev:my-app

# === 測試權限 ===
# 模擬 ServiceAccount 的 API 請求
kubectl auth can-i list pods -n dev --as=system:serviceaccount:dev:my-app
# yes

kubectl auth can-i delete pods -n dev --as=system:serviceaccount:dev:my-app
# no

# 跨 Namespace
kubectl auth can-i list pods -n default --as=system:serviceaccount:dev:my-app
# no（只有 dev namespace 的 binding）

# === 查看現有 RBAC ===
kubectl get roles,rolebindings -n dev
kubectl get clusterroles,clusterrolebindings | grep -v system:

# 查看某個 ServiceAccount 有哪些權限
kubectl auth can-i --list --as=system:serviceaccount:dev:my-app -n dev

# === 測試 Secret 存取（Audit）===
# 確認 etcd 加密（production 必做）
kubectl -n kube-system get cm kubeadm-config -o yaml | grep encryption

# === PSA（Pod Security Admission）===
# 設定 Namespace 安全等級
kubectl label namespace dev pod-security.kubernetes.io/enforce=restricted
kubectl label namespace dev pod-security.kubernetes.io/warn=restricted

# 確認：不符合 restricted 的 Pod 會被拒絕
kubectl -n dev run test --image=nginx    # 應該被拒絕（需要 non-root）

# 重設（允許）
kubectl label namespace dev pod-security.kubernetes.io/enforce-
```
