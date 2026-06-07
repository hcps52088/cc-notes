# K8s 核心架構

## 整體結構

```
┌──────────────────────────── k8s Cluster ──────────────────────────────┐
│                                                                         │
│  ┌─────────────────────────── Control Plane ────────────────────────┐  │
│  │                                                                   │  │
│  │  kube-apiserver     ←── 所有操作的唯一入口（REST API）             │  │
│  │       │                                                           │  │
│  │      etcd           ←── Cluster 唯一的 source of truth            │  │
│  │       │                                                           │  │
│  │  kube-scheduler     ←── 決定 Pod 跑在哪個 Node                    │  │
│  │  kube-controller-manager ←── 確保現狀符合期望狀態                 │  │
│  │  cloud-controller-manager ←── 對接雲端 API（AWS/GCP/Azure）       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                    │                                     │
│  ┌───── Worker Node ─────┐  ┌───── Worker Node ─────┐                  │
│  │  kubelet              │  │  kubelet              │                   │
│  │  kube-proxy           │  │  kube-proxy           │                   │
│  │  Container Runtime    │  │  Container Runtime    │                   │
│  │  (containerd)         │  │  (containerd)         │                   │
│  └───────────────────────┘  └───────────────────────┘                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Control Plane 元件詳解

### kube-apiserver

**所有操作的唯一入口**，無論是 `kubectl`、Controller、kubelet 還是其他元件，都只和 API Server 溝通，沒有任何元件直接讀寫 etcd。

```
kubectl apply -f pod.yaml
        │
        ▼
kube-apiserver（HTTPS :6443）
  ├── 1. Authentication（你是誰？）
  │      - X.509 certificate / Bearer token / OIDC
  ├── 2. Authorization（你能做什麼？）
  │      - RBAC：Role + RoleBinding
  ├── 3. Admission Control（這個操作合法嗎？）
  │      - Mutating Webhook（可修改請求，如補預設值）
  │      - Validating Webhook（只能 approve/deny）
  │      - Built-in Admission Plugins（ResourceQuota、LimitRanger 等）
  └── 寫入 etcd
```

API Server 是**無狀態**的，可以水平擴展。High Availability 環境通常跑 3 個，前面放 Load Balancer。

### etcd

- **分散式 key-value store**，存整個 cluster 的狀態（所有資源的 YAML）
- 使用 **Raft 共識演算法**，節點數必須是奇數（3 或 5），容忍 (n-1)/2 個節點故障
- **只有 API Server 能直接讀寫它**，其他元件都透過 API Server 間接讀寫
- Watch 機制：etcd 支援 Watch API，元件可以 Watch 某個 key 的變化，當資源更新時立刻收到通知（而不是輪詢）

> 備份 etcd = 備份整個 cluster。Production 環境必定要定期備份 etcd snapshot。

```bash
# 備份 etcd
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-snapshot.db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

### kube-scheduler

唯一工作：把**沒有 Node 的 Pod 分配到合適的 Node**。

調度是兩個階段：

```
1. Filtering（篩掉不符合的 Node）
   - NodeSelector / nodeAffinity
   - Resource requests（Node 有足夠 CPU/Memory 嗎？）
   - Taints（Node 有沒有 taint 阻擋這個 Pod？）
   - hostPort 衝突
   - Volume topology constraints

2. Scoring（對剩餘 Node 打分）
   - LeastAllocated：優先分配到資源使用率最低的 Node
   - InterPodAffinity：親和性得分
   - ImageLocality：Node 已有 container image 得分高
   → 選分數最高的 Node
```

Scheduler 不直接操作 Pod，它只把 Pod 的 `spec.nodeName` 填上去，剩下的由 kubelet 完成。

### kube-controller-manager

跑著幾十個 built-in controller，每個 controller 的邏輯都一樣：

```
Watch 現狀  →  比對期望狀態  →  採取行動
```

常見 controller：

| Controller | 負責什麼 |
|-----------|---------|
| Deployment Controller | 確保 ReplicaSet 存在且數量正確 |
| ReplicaSet Controller | 確保 Pod 數量符合 replicas |
| Node Controller | 監控 Node 狀態，處理 NotReady 的 Node |
| Job Controller | 管理 Job 和它的 Pod |
| CronJob Controller | 依排程建立 Job |
| Endpoint Controller | 維護 Service 和 Pod 的對應（Endpoints） |
| Namespace Controller | 處理 Namespace 刪除的連鎖效應 |

### kubelet

跑在**每個 Node** 上的代理，是 API Server 在 Node 上的代理人。

- 向 API Server 註冊自己（Node resource）
- Watch API Server 上分配給自己的 Pod
- 透過 **CRI（Container Runtime Interface）** 叫 containerd 拉 image、啟動 container
- 管理 Volume 掛載、Secret/ConfigMap 注入
- 定期回報 Node 和 Pod 的狀態

!!! warning "kubelet 不受 API Server 控制"
    kubelet 是直接跑在 Node 的 process。API Server 故障時，kubelet 繼續維持已在跑的 Pod，但無法啟動新 Pod 或接收新指令。

### kube-proxy

維護每個 Node 上的**網路轉發規則**，實作 Service 的流量路由。

- 預設使用 **iptables** 模式（每個 Service 建立 iptables 規則）
- 大型 cluster 改用 **IPVS** 模式（效能更好，規則數量不影響效能）
- kube-proxy 不處理 Pod-to-Pod 的直接通訊（那是 CNI 的責任）

### kube-proxy 模式比較

| | iptables | IPVS | eBPF（Cilium 取代 kube-proxy）|
|--|---------|------|------------------------------|
| **實作** | Netfilter iptables 規則 | Linux IPVS（LVS） | eBPF 程式直接在 kernel 運作 |
| **Service 數量規模** | 小到中型（規則線性增長） | 大型（Hash table，O(1)） | 大型（Hash table，O(1)） |
| **負載均衡算法** | Round-robin（隨機） | RR / LC / SH / DH 等多種 | 自訂 |
| **Connection tracking** | conntrack | conntrack | 可繞過 conntrack |
| **效能（大規模）** | 差 | 好 | 最好 |
| **需要額外安裝** | ❌（預設） | 需要 ipvs kernel module | 需要安裝 Cilium |

---

## 最重要的設計思路：Reconciliation Loop

> 你不是在「下命令」，你是在「宣告你要的終態」，k8s 自己想辦法達到它。

```
你 kubectl apply Deployment（replicas: 3）
        │
        ▼
API Server 寫入 etcd（期望狀態：3 個 Pod）
        │
        ▼ Watch 事件
Deployment Controller：
  現狀：0 Pod，期望：3 Pod
  → 建立 ReplicaSet
        │
        ▼ Watch 事件
ReplicaSet Controller：
  現狀：0 Pod，期望：3 Pod
  → 建立 3 個 Pod（狀態：Pending）
        │
        ▼ Watch 事件
Scheduler：
  看到 Pending Pod → 計算最佳 Node → 填入 spec.nodeName
        │
        ▼ Watch 事件
kubelet（在被分配的 Node 上）：
  看到分配給自己的 Pod → 叫 containerd 啟動 container
  → Pod 變成 Running → 更新狀態到 API Server
        │
        ▼ Watch 事件
Deployment/ReplicaSet Controller：
  現狀 = 期望 → 不動作 ✅
```

**為什麼這個設計很重要？** 自我修復是免費的：當一個 Pod 崩潰，Controller 偵測到「現狀 < 期望」就自動補起來，你不需要寫任何恢復腳本。

---

## 基本物件：Pod

Pod 是 k8s 最小的部署單位，一個 Pod 裡的 container 共享：
- **網路 namespace**（相同 IP、可用 localhost 互通）
- **Volume**（掛載點共享）
- **Linux namespace**（可選：UTS、IPC）

### Pod 生命週期

```
Pending  →  Running  →  Succeeded
                    ↘  Failed
                    ↘  Unknown（Node 失聯）
```

Pod 狀態轉換的關鍵：**Container 的 Init container、Probes、RestartPolicy**

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: my-pod
  labels:
    app: my-app          # Label：用於 Selector 找到這個 Pod
  annotations:
    description: "示範 Pod"  # Annotation：補充資訊，不影響調度
spec:
  initContainers:          # Init container：在主 container 前跑
    - name: init-db
      image: busybox
      command: ['sh', '-c', 'until nc -z db 5432; do sleep 1; done']

  containers:
    - name: app
      image: nginx:1.25
      ports:
        - containerPort: 80

      resources:             # 資源設定（調度和限制的關鍵）
        requests:            # Scheduler 根據此值選 Node
          cpu: "100m"        # 0.1 CPU core
          memory: "128Mi"
        limits:              # 超過 → CPU 被throttle，Memory → OOMKilled
          cpu: "500m"
          memory: "512Mi"

      env:                   # 環境變數
        - name: DB_HOST
          value: "postgres"
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: password

      volumeMounts:
        - name: config
          mountPath: /etc/app/config.yaml
          subPath: config.yaml

      livenessProbe:         # 失敗 → 重啟 container
        httpGet:
          path: /healthz
          port: 8080
        initialDelaySeconds: 10
        periodSeconds: 5

      readinessProbe:        # 失敗 → 從 Service 的 Endpoint 移除
        httpGet:
          path: /ready
          port: 8080
        initialDelaySeconds: 5

      startupProbe:          # 啟動期間的探針（給啟動慢的 app 用）
        httpGet:
          path: /healthz
          port: 8080
        failureThreshold: 30  # 最多等 30 × 10s = 5 分鐘
        periodSeconds: 10

  volumes:
    - name: config
      configMap:
        name: my-config

  restartPolicy: Always     # 容器退出後是否重啟：Always / OnFailure / Never
  nodeSelector:
    disk: ssd               # 只調度到有 disk=ssd label 的 Node
```

---

## 關鍵物件

### Namespace

邏輯隔離，不是安全邊界（不同 namespace 的 Pod 默認可以互通）。

```bash
kubectl create namespace dev
kubectl -n dev get pods          # 查看 dev namespace 的 pod
kubectl get pods --all-namespaces  # 查看所有 namespace
```

### ConfigMap 和 Secret

```yaml
# ConfigMap：非機密設定
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  APP_ENV: "production"
  config.yaml: |
    server:
      port: 8080
      timeout: 30s

---
# Secret：機密資料（base64 編碼，不是加密！）
apiVersion: v1
kind: Secret
metadata:
  name: db-secret
type: Opaque
stringData:            # 用 stringData 自動 base64
  password: "supersecret"
```

!!! warning "Secret 只是 base64，不是加密"
    `kubectl get secret -o yaml` 就能解碼。真正的機密管理要搭配 Sealed Secrets、HashiCorp Vault、或 AWS Secrets Manager。

### 工作負載資源比較

| 資源 | 管理對象 | 特性 | 適合場景 |
|------|---------|------|---------|
| **Pod** | 直接管理 | 最基本單位，無自愈 | 不直接用 |
| **Deployment** | ReplicaSet → Pod | 滾動更新、無狀態 | Web 服務、API |
| **StatefulSet** | Pod（有穩定 ID） | 穩定網路名稱、有序啟動/更新 | 資料庫、Kafka |
| **DaemonSet** | 每個 Node 一個 Pod | 自動跟隨 Node 增減 | 監控 agent、CNI、CSI Node plugin |
| **Job** | Pod（一次性） | 執行完成即結束 | 資料遷移、批次處理 |
| **CronJob** | Job | 按排程建立 Job | 定時備份、定時清理 |

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web         # 管理有 app=web label 的 Pod
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1       # 最多比 replicas 多 1 個 Pod（新）
      maxUnavailable: 0 # 最少保持 replicas 個 Pod 可用
  template:            # Pod template（下面的 label 必須和 selector 一致）
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.25
```

```bash
# 滾動更新
kubectl set image deployment/web web=nginx:1.26
kubectl rollout status deployment/web

# 回滾
kubectl rollout undo deployment/web
kubectl rollout undo deployment/web --to-revision=2

# 查看更新歷史
kubectl rollout history deployment/web
```

### Service

```yaml
# ClusterIP（cluster 內部存取）
apiVersion: v1
kind: Service
metadata:
  name: web-svc
spec:
  selector:
    app: web           # 轉發流量到有 app=web label 的 Pod
  ports:
    - port: 80
      targetPort: 8080
  type: ClusterIP

---
# NodePort（從外部透過 Node IP 存取）
spec:
  type: NodePort
  ports:
    - port: 80
      nodePort: 30080  # 每個 Node 都開 30080 port

---
# LoadBalancer（雲端環境，自動建立 LB）
spec:
  type: LoadBalancer
```

### HorizontalPodAutoscaler（HPA）

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: web-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: web
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70   # CPU 超過 70% 就 scale out
```

---

## 調度進階控制

### Taint 和 Toleration

Taint 讓 Node「排斥」某些 Pod，Toleration 讓 Pod「容忍」某些 Taint。

```bash
# 給 Node 加 taint（只有有 toleration 的 Pod 才能調度到這個 Node）
kubectl taint node node1 dedicated=gpu:NoSchedule

# 移除 taint
kubectl taint node node1 dedicated=gpu:NoSchedule-
```

```yaml
# Pod 要有對應 toleration 才能跑在 tainted Node 上
spec:
  tolerations:
    - key: dedicated
      operator: Equal
      value: gpu
      effect: NoSchedule
```

Taint effect：
- `NoSchedule`：新 Pod 不調度（已在的繼續跑）
- `PreferNoSchedule`：盡量不調度
- `NoExecute`：不調度且驅逐已在的 Pod

### Node Affinity

比 nodeSelector 更靈活的調度控制：

```yaml
spec:
  affinity:
    nodeAffinity:
      # 硬性要求（不符合就不調度）
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: zone
                operator: In
                values: [us-east-1a, us-east-1b]

      # 軟性偏好（盡量，但不強制）
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          preference:
            matchExpressions:
              - key: disk
                operator: In
                values: [ssd]
```

### Pod Anti-Affinity（讓副本分散到不同 Node）

```yaml
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: web           # 同一個 app 的 Pod
          topologyKey: kubernetes.io/hostname  # 不能在同一個 Node
```

---

## 一個請求的完整旅程

```
kubectl apply -f deployment.yaml
        │
        ▼
① API Server 收到請求
   → Authentication（誰發的？）
   → Authorization（有權限嗎？）
   → Admission（合規嗎？LimitRanger 補預設值）
   → 寫入 etcd
        │ Watch 通知
        ▼
② Deployment Controller
   → 發現沒有對應的 ReplicaSet → 建立 ReplicaSet
        │ Watch 通知
        ▼
③ ReplicaSet Controller
   → 現狀 0 Pod，期望 3 → 建立 3 個 Pod（Pending）
        │ Watch 通知
        ▼
④ Scheduler
   → 看到 Pending Pod（nodeName 空著）
   → Filtering：排除不符合資源要求的 Node
   → Scoring：選最佳 Node
   → 填入 Pod spec.nodeName
        │ Watch 通知
        ▼
⑤ kubelet（在被選中的 Node 上）
   → 看到分配給自己的 Pod
   → 透過 CRI 叫 containerd：拉 image → 建立 container → 啟動
   → Pod 狀態更新為 Running
   → 回報 API Server → 寫入 etcd ✅
```

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：如果 API Server 掛掉，cluster 會發生什麼事？
**答案：**

- **已在跑的 Pod 繼續跑**：kubelet 不依賴 API Server 來維持現有 Pod
- **無法建立新 Pod / Service / 任何新資源**：所有變更都走 API Server
- **kubectl 所有指令失效**：無法下達任何操作
- **Scheduler 和 Controller 停止運作**：它們的指令也走 API Server
- **etcd 不受影響**：etcd 繼續運作，只是無法接受新的讀寫

這就是為什麼 Production 環境要用奇數個 Control Plane（3 或 5）+  Load Balancer，確保 API Server HA。
:::

::: details 測驗 2：liveness probe 和 readiness probe 的差異和使用場景？
**答案：**

| | liveness | readiness |
|--|---------|----------|
| 失敗時 | 重啟 container | 從 Service Endpoint 移除 |
| 用途 | 偵測 container 卡死 | 判斷是否準備好接流量 |

**典型場景：**
- `liveness`：app 有 deadlock，進程還活著但不回應 → 重啟
- `readiness`：app 啟動中連資料庫、載入快取 → 先不接流量，完成後再加入

**startup probe** 是第三種：給啟動特別慢的 app（如 Java），在 startup probe 成功前不啟動 liveness 檢查，避免因為啟動慢被誤殺。
:::

::: details 測驗 3：`requests` 和 `limits` 的差異？把 requests 設太低有什麼風險？
**答案：**

- **requests**：Scheduler 用來選 Node（Node 可分配資源 ≥ requests 才考慮）；OOM Killer 的優先順序依據
- **limits**：執行時的上限，CPU 超過會 throttle，Memory 超過直接 OOMKilled

**把 requests 設太低的風險：**
- Scheduler 把 Pod 調度到實際資源不足的 Node（虛報資源需求）
- 多個 Pod 搶同一個 Node 的資源，都跑慢、甚至 OOMKilled
- 正確做法：requests 設成 P95 的實際使用量，limits 設成可接受的最大值
:::

::: details 測驗 4：Taint `NoSchedule` 和 `NoExecute` 有什麼差別？
**答案：**

- **NoSchedule**：新 Pod 不會調度到這個 Node，但已在跑的 Pod **不受影響**，繼續跑
- **NoExecute**：新 Pod 不調度 + **已在跑的 Pod 被驅逐**（除非有 tolerationSeconds 寬限期）

**常見使用場景：**
- `kubectl drain` 在背後做的是：先給 Node 加 `NoSchedule` taint，再驅逐 Pod
- Node 進入 `NotReady` 狀態時，k8s 自動加 `node.kubernetes.io/not-ready:NoExecute` taint，等待 tolerationSeconds（預設 300 秒）後驅逐 Pod
:::

---

## 實作：探索 Cluster 狀態

```bash
# === 查看 Cluster 資訊 ===
kubectl cluster-info
kubectl get nodes -o wide          # 查看所有 Node 和 IP
kubectl describe node <node-name>  # Node 詳細資訊（容量、Taint、已用資源）

# === 查看 Control Plane 元件 ===
kubectl -n kube-system get pods    # Control Plane Pod 都跑在這裡
kubectl -n kube-system get pods -l component=etcd
kubectl -n kube-system logs kube-scheduler-<node> --tail=20

# === Pod 操作 ===
kubectl get pods -o wide           # 包含 Node 名稱
kubectl describe pod <name>        # Events 是 debug 的第一步
kubectl logs <pod> -c <container>  # 多 container pod 指定 container
kubectl logs <pod> --previous      # 上一個 container 的 log（已重啟的）
kubectl exec -it <pod> -- bash     # 進入 container

# === 查看資源使用率（需要 metrics-server）===
kubectl top nodes
kubectl top pods --all-namespaces

# === 追蹤 Deployment 更新 ===
kubectl set image deployment/web web=nginx:1.26
kubectl rollout status deployment/web  # 等待完成
kubectl rollout history deployment/web # 查看更新歷史

# === 測試調度 ===
# 手動給 Node 加 label
kubectl label node <node-name> disk=ssd

# 查看哪個 Node 被選中
kubectl get pod <pod> -o jsonpath='{.spec.nodeName}'

# 模擬 Node 維護（搬走 Pod）
kubectl cordon <node>      # 設為 unschedulable（不再接新 Pod）
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
kubectl uncordon <node>    # 恢復 schedulable
```
