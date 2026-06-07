# 第一章：K8s 核心架構

## 整體結構

```
┌─────────────────────── k8s Cluster ──────────────────────┐
│                                                            │
│  ┌──────────── Control Plane ────────────┐                │
│  │  API Server  ←── 所有操作的唯一入口      │                │
│  │      ↕                               │                │
│  │    etcd      ←── 唯一的資料來源         │                │
│  │                   (source of truth)   │                │
│  │      ↕                               │                │
│  │  Scheduler   ←── 決定 Pod 跑在哪個 Node │                │
│  │  Controller  ←── 確保現狀符合期望狀態    │                │
│  │  Manager                              │                │
│  └───────────────────────────────────────┘                │
│                                                            │
│  ┌──── Worker Node ────┐  ┌──── Worker Node ────┐        │
│  │  kubelet            │  │  kubelet            │        │
│  │  kube-proxy         │  │  kube-proxy         │        │
│  │  Container Runtime  │  │  Container Runtime  │        │
│  │  (containerd)       │  │  (containerd)       │        │
│  └─────────────────────┘  └─────────────────────┘        │
└───────────────────────────────────────────────────────────┘
```

---

## 各元件職責

### API Server

- k8s 的「前台」，所有操作（`kubectl`、Controller 讀狀態）都經過它
- **無狀態**，可以水平擴展
- 負責三道關卡：Authentication → Authorization (RBAC) → Admission Control

### etcd

- 分散式 key-value store，存整個 cluster 的狀態
- **只有 API Server 能直接讀寫它**，其他元件不碰
- 這是最脆弱的元件：**備份 etcd = 備份整個 cluster**

### Scheduler

- 唯一工作：把「還沒有 Node 的 Pod」分配到合適的 Node
- 考量因素：資源需求、affinity/anti-affinity、taints/tolerations

### Controller Manager

- 跑著一堆 controller（ReplicaSet、Deployment、Node controller 等）
- 每個 controller 的邏輯都一樣：**Watch 現狀 → 比對期望狀態 → 調整**

### kubelet

- 跑在每個 Node 上，負責讓 Pod 實際跑起來
- 向 API Server 回報 Node 狀態
- 不直接管 container，透過 CRI（Container Runtime Interface）叫 containerd

### kube-proxy

- 維護每個 Node 上的網路規則（iptables / ipvs）
- 實作 Service 的流量轉發

---

## 最重要的設計思路：Reconciliation Loop

!!! tip "核心觀念"
    你不是在「下命令」，你是在「宣告你要的終態」，k8s 自己想辦法達到它。

```
你下 kubectl apply
        ↓
API Server 更新 etcd 的「期望狀態」
        ↓
Controller 持續 Watch etcd
發現「現狀 ≠ 期望」
        ↓
Controller 採取行動（建立/刪除 Pod）
        ↓
kubelet 讓 Pod 實際跑起來
更新「現狀」到 etcd
        ↓
Controller 再次 Watch
現狀 = 期望 → 停止動作 ✅
```

---

## 一個請求的完整旅程

執行 `kubectl apply -f deployment.yaml` 後發生什麼：

```
1. kubectl 把 YAML 送給 API Server（HTTPS）
2. API Server：Authentication → Authorization (RBAC) → Admission Webhook
3. 寫入 etcd（狀態變為 "期望 3 個 Pod"）
4. Deployment Controller watch 到變化 → 建立 ReplicaSet
5. ReplicaSet Controller → 建立 3 個 Pod（狀態：Pending）
6. Scheduler watch 到 Pending Pod → 分配 Node → 更新 Pod spec
7. 各 Node 的 kubelet watch 到分配給自己的 Pod
   → 叫 containerd 拉 image、啟動 container
8. kubelet 回報 Pod Running → etcd 更新 ✅
```

---

## 常見陷阱

!!! warning "etcd 是單點風險"
    etcd 掛掉整個 cluster 就無法運作。Production 環境一定要跑 etcd cluster（奇數節點，至少 3 個），並定期備份。

!!! warning "kubelet 不受 API Server 管"
    kubelet 是直接跑在 Node 上的 process，API Server 掛掉時 kubelet 還是會繼續維持已在跑的 Pod，但無法接受新的指令。

!!! info "Controller Manager 是單一 process"
    所有 built-in controller 都跑在同一個 `kube-controller-manager` process 裡，但各自獨立運作，互不干擾。
