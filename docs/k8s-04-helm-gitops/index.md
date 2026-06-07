# 第四章：Helm & GitOps

## 為什麼需要 Helm？

直接用 `kubectl apply` 管理多個 YAML 的問題：

- 同一份 app 部署到 dev / staging / prod，要維護三份幾乎一樣的 YAML
- 版本管理困難，不知道目前跑的是哪個版本
- 沒有 rollback 機制
- 多個關聯資源（Deployment + Service + Ingress + ConfigMap）要一起管理

Helm 把這些 YAML 打包成一個 **Chart**，用變數（Values）區分不同環境。

---

## Helm 核心概念

```
Chart（模板 + 預設值）
    │
    │  + values.yaml（或 -f custom.yaml）
    ▼
Release（部署到 cluster 的實例）
```

| 名詞 | 說明 |
|------|------|
| **Chart** | Helm 的套件，包含模板和預設設定 |
| **Release** | 一次 `helm install` 的執行結果，有版本號 |
| **Values** | 覆蓋預設設定的參數 |
| **Repository** | 存放 Chart 的倉庫（類似 npm registry） |
| **Revision** | Release 的版本，每次 upgrade 遞增 |

---

## Chart 目錄結構

```
my-app/
├── Chart.yaml          # Chart 基本資訊（名稱、版本、描述）
├── values.yaml         # 預設參數值
├── templates/          # YAML 模板
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── ingress.yaml
│   ├── configmap.yaml
│   ├── _helpers.tpl    # 共用的 template helper（底線開頭，不直接渲染）
│   └── NOTES.txt       # helm install 完後顯示的說明訊息
├── charts/             # 依賴的子 Chart
└── .helmignore         # 不打包進 Chart 的檔案
```

### Chart.yaml

```yaml
apiVersion: v2
name: my-app
description: My Application Helm Chart
type: application
version: 0.1.0        # Chart 版本
appVersion: "1.2.3"   # 應用程式版本（顯示用）
```

---

## Values 設計

### values.yaml（預設值）

```yaml
replicaCount: 1

image:
  repository: my-app
  tag: "latest"
  pullPolicy: IfNotPresent

service:
  type: ClusterIP
  port: 80

ingress:
  enabled: false
  host: ""

resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 100m
    memory: 128Mi

env:
  LOG_LEVEL: info
  DB_HOST: localhost
```

### 模板裡引用 Values

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-{{ .Chart.Name }}
  labels:
    app: {{ .Chart.Name }}
    version: {{ .Chart.AppVersion }}
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: {{ .Chart.Name }}
  template:
    spec:
      containers:
        - name: {{ .Chart.Name }}
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          ports:
            - containerPort: {{ .Values.service.port }}
          env:
            {{- range $key, $val := .Values.env }}
            - name: {{ $key }}
              value: {{ $val | quote }}
            {{- end }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
```

### 不同環境用不同 Values

```yaml
# values-prod.yaml（只覆蓋需要改的）
replicaCount: 3

image:
  tag: "v1.2.3"

ingress:
  enabled: true
  host: myapp.example.com

resources:
  limits:
    cpu: 2
    memory: 2Gi
```

---

## 常用 Helm 指令

```bash
# 搜尋 Chart
helm search repo nginx
helm search hub postgresql

# 新增 repository
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# 安裝
helm install my-release bitnami/nginx
helm install my-release ./my-app -f values-prod.yaml

# 預覽渲染結果（不實際安裝）
helm template my-release ./my-app -f values-prod.yaml

# 升級
helm upgrade my-release ./my-app -f values-prod.yaml
helm upgrade --install my-release ./my-app  # 不存在就 install，存在就 upgrade

# 查看狀態
helm list
helm status my-release
helm history my-release

# Rollback
helm rollback my-release 2    # 回到第 2 個 revision

# 卸載
helm uninstall my-release
```

---

## _helpers.tpl：避免重複

```yaml
# templates/_helpers.tpl
{{- define "my-app.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

# 在其他模板引用
metadata:
  labels:
    {{- include "my-app.labels" . | nindent 4 }}
```

---

## GitOps 是什麼？

傳統部署：
```
開發者 → kubectl apply → Cluster
```

GitOps：
```
開發者 → Push to Git → Git（唯一 source of truth）
                          ↑ GitOps operator 持續同步
                       Cluster（自動對齊 Git 狀態）
```

### GitOps 的四個原則

1. **宣告式**：所有系統狀態都用 YAML 描述
2. **版本化**：所有設定都在 Git，有完整歷史
3. **自動同步**：Git 變動 → Cluster 自動跟上
4. **持續調和**：operator 持續確保 cluster 狀態 = Git 狀態

---

## ArgoCD

ArgoCD 是最主流的 GitOps 工具，在 cluster 裡跑一個 operator，持續監看 Git repo，自動把 Git 的狀態同步到 cluster。

### 核心概念

```
Git Repo（YAML/Helm/Kustomize）
    │
    │  ArgoCD 持續 diff
    ▼
Application（ArgoCD 的資源）
    │
    │  自動或手動 sync
    ▼
Cluster（target state）
```

### Application 資源

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: argocd
spec:
  project: default
  source:
    repoURL: https://github.com/my-org/k8s-configs
    targetRevision: main
    path: apps/my-app/overlays/production
    # 如果是 Helm Chart：
    # helm:
    #   valueFiles:
    #     - values-prod.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: production
  syncPolicy:
    automated:
      prune: true      # Git 刪除的資源，cluster 也刪
      selfHeal: true   # 有人手動改 cluster，自動還原
    syncOptions:
      - CreateNamespace=true
```

### 常用指令

```bash
# 安裝 ArgoCD
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 取得初始密碼
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d

# 用 CLI 操作
argocd login <argocd-server>
argocd app list
argocd app sync my-app
argocd app rollback my-app 3
```

---

## Flux

Flux 是另一個主流 GitOps 工具，和 ArgoCD 相比更輕量、更 Kubernetes-native（用 CRD 描述一切）。

### Flux vs ArgoCD

| | ArgoCD | Flux |
|--|--------|------|
| UI | 有內建 Web UI | 無（需另裝） |
| 架構 | 單一 server | 多個 controller 組合 |
| Multi-tenancy | Application + Project | Tenant 隔離 |
| Image 自動更新 | 需插件 | 內建 Image Automation |
| 適合場景 | 需要 UI 的團隊 | 偏 CLI / 自動化流程 |

### Flux 核心資源

```yaml
# GitRepository：監看哪個 Git repo
apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: my-repo
  namespace: flux-system
spec:
  interval: 1m
  url: https://github.com/my-org/k8s-configs
  ref:
    branch: main

---
# Kustomization：從 Git repo 同步哪個路徑
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: my-app
  namespace: flux-system
spec:
  interval: 5m
  path: ./apps/production
  prune: true
  sourceRef:
    kind: GitRepository
    name: my-repo
  targetNamespace: production
```

---

## 實務推薦的 Repo 結構

```
k8s-configs/                # GitOps 的 Git repo
├── apps/
│   ├── base/               # 所有環境共用的 base
│   │   ├── deployment.yaml
│   │   └── service.yaml
│   └── overlays/
│       ├── dev/            # dev 環境的 patch
│       │   └── kustomization.yaml
│       ├── staging/
│       └── production/     # prod 環境的 patch
│           ├── kustomization.yaml
│           └── replica-patch.yaml
├── infrastructure/
│   ├── cert-manager/
│   ├── ingress-nginx/
│   └── monitoring/
└── clusters/
    ├── dev/                # 指向 dev 環境的 ArgoCD Application
    └── production/
```

---

## CI/CD 整合流程

```
開發者 push code
    │
    ▼
CI Pipeline（GitHub Actions / GitLab CI）
    ├── 跑測試
    ├── Build Docker image
    ├── Push image 到 registry
    └── 更新 k8s-configs repo 的 image tag
              │
              ▼
        GitOps Operator（ArgoCD / Flux）偵測到 Git 變動
              │
              ▼
        自動 sync 到 Cluster
```

---

## 常見陷阱

!!! warning "Helm Values 裡不要放 Secret"
    `values.yaml` 會進 Git，不能放密碼、API key。改用 Kubernetes Secret 或 External Secrets，在 values 裡只放 Secret 名稱。

!!! warning "自動 prune 要謹慎"
    ArgoCD / Flux 的 `prune: true` 會刪除 Git 裡沒有的資源。如果手動 apply 了一些資源沒有放進 Git，啟用 prune 後就會被自動刪掉。

!!! warning "Helm upgrade 要有 --atomic"
    ```bash
    helm upgrade my-release ./my-app --atomic --timeout 5m
    ```
    `--atomic` 讓升級失敗時自動 rollback，避免 cluster 停在一個壞掉的中間狀態。

!!! info "App of Apps 模式"
    ArgoCD 可以用一個 Application 管理其他所有 Application（App of Apps pattern），這樣新增服務只要在 Git 加一個 YAML，ArgoCD 就自動部署。

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：Helm Chart 和 kubectl apply 直接套用 YAML 的差別？什麼情況下用 Helm？
**答案：**

| | kubectl apply | Helm Chart |
|--|--------------|-----------|
| 版本管理 | 無（需要 git） | Helm release 版本 |
| 回滾 | 需要 git revert | `helm rollback` |
| 參數化 | 手動改 YAML | `values.yaml` + template |
| 相依管理 | 手動 | `Chart.yaml` dependencies |
| 現狀追蹤 | 不追蹤（kubectl apply 只記憶上次的） | `helm ls` 顯示所有 release 狀態 |

**用 Helm 的時機：**
- 安裝有很多設定選項的 third-party 工具（Prometheus、ingress-nginx、cert-manager）
- 需要在多個環境（dev/staging/prod）用不同設定部署同一套應用

**不用 Helm 的時機：**
- 簡單的自建應用（直接 YAML + GitOps 更清楚）
- Helm template 太複雜，失去了「YAML 即文件」的可讀性
:::

::: details 測驗 2：GitOps 的核心原則是什麼？ArgoCD 和 Flux 的主要差別？
**答案：**

**GitOps 核心原則**：
1. **Git as single source of truth**：所有設定都在 Git，沒有手動的 `kubectl apply`
2. **Declarative**：描述終態，不是操作步驟
3. **Automated reconciliation**：工具自動把 cluster 狀態同步到 Git 的狀態

**ArgoCD vs Flux：**

| | ArgoCD | Flux |
|--|-------|------|
| UI | 強大的 Web UI | 無 UI（需要額外安裝） |
| 操作方式 | Web / argocd CLI | kubectl / flux CLI |
| 架構 | 集中式（獨立 server） | 分散式（每個 cluster 自己 pull） |
| Multi-cluster | 支援（從單一 UI 管多個 cluster） | 每個 cluster 裝自己的 Flux |
| 適合場景 | 有 Ops 團隊需要 visibility | 小型團隊、開發者自助 |
:::

::: details 測驗 3：`helm upgrade --install` 和 `helm upgrade` 的差別？`--atomic` 旗標的作用？
**答案：**

- `helm upgrade`：更新已有的 release，若 release 不存在就失敗
- `helm upgrade --install`：有 release 就更新，沒有就新安裝（CI/CD 常用，不需要判斷是不是第一次）

**`--atomic` 的作用：**

若升級過程中有 Pod 沒有在 timeout 內 Ready，自動執行 `helm rollback` 回到上一個版本，避免 cluster 停在壞掉的中間狀態。

```bash
helm upgrade my-app ./my-chart --atomic --timeout 5m
# 5 分鐘內 Pod 沒有 Ready → 自動 rollback
```

不加 `--atomic` 的問題：upgrade 卡住時，舊 Pod 已被刪除，新 Pod 啟動失敗，Service 無法服務，需要手動 rollback。
:::

---

## 實作：Helm 和 ArgoCD 基本操作

```bash
# === Helm 基本操作 ===
# 新增 repo
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

# 搜尋 chart
helm search repo ingress-nginx

# 查看 default values
helm show values ingress-nginx/ingress-nginx

# 安裝（用自訂 values）
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.replicaCount=2 \
  --set controller.service.type=LoadBalancer

# 查看 release 狀態
helm ls -n ingress-nginx
helm status ingress-nginx -n ingress-nginx

# 升級（改設定）
helm upgrade ingress-nginx ingress-nginx/ingress-nginx \
  -n ingress-nginx \
  --set controller.replicaCount=3 \
  --atomic --timeout 5m

# 回滾
helm rollback ingress-nginx 1 -n ingress-nginx   # 回到版本 1

# 查看升級歷史
helm history ingress-nginx -n ingress-nginx

# 解除安裝
helm uninstall ingress-nginx -n ingress-nginx

# === ArgoCD 基本操作 ===
# 安裝 ArgoCD
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 等待 ArgoCD 就緒
kubectl -n argocd wait --for=condition=available deployment/argocd-server --timeout=300s

# 取得初始 admin 密碼
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d

# port-forward 存取 UI
kubectl port-forward svc/argocd-server -n argocd 8080:443 &
# 瀏覽器開 https://localhost:8080

# 登入 CLI
argocd login localhost:8080 --username admin --insecure

# 建立 Application（從 Git 同步）
argocd app create my-app \
  --repo https://github.com/your-org/your-app.git \
  --path k8s/ \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace default \
  --sync-policy automated \
  --auto-prune \
  --self-heal

# 查看同步狀態
argocd app list
argocd app get my-app
argocd app sync my-app      # 手動觸發同步
argocd app history my-app   # 查看部署歷史
argocd app rollback my-app  # 回滾
```
