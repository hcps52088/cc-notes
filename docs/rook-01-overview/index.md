# Rook 架構概覽

## Rook 是什麼？

Rook 是 **Ceph 的 Kubernetes Operator**，讓你用 `kubectl apply` 來部署和管理一個完整的 Ceph Cluster，不需要手動執行 `ceph-deploy` 或 Ansible。

```
你只需要寫 YAML：                 Rook 幫你做：
┌────────────────────┐            ┌─────────────────────────┐
│ CephCluster        │            │ 部署 MON、OSD、MGR       │
│ CephBlockPool      │  ──────▶  │ 建立 Ceph Pool           │
│ CephFilesystem     │            │ 設定 CSI Driver          │
│ CephObjectStore    │            │ 建立 StorageClass        │
└────────────────────┘            │ 監控並自動修復           │
                                  └─────────────────────────┘
```

**Rook 是 CNCF Graduated 專案**（2020 年畢業，與 k8s、Prometheus 同等級）。

---

## 架構圖

```
┌─────────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                        │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                 rook-ceph namespace                  │   │
│  │                                                     │   │
│  │  ┌─────────────┐    ┌──────────────────────────┐   │   │
│  │  │ rook-operator│    │    Ceph Cluster           │   │   │
│  │  │  (Deployment)│    │                          │   │   │
│  │  │             │    │  MON × 3   MGR × 2        │   │   │
│  │  │  Watch CRD  │    │  OSD × N（每顆磁碟一個）   │   │   │
│  │  │  Reconcile  │    │  MDS × N  RGW × N         │   │   │
│  │  └─────────────┘    └──────────────────────────┘   │   │
│  │                                                     │   │
│  │  ┌─────────────────────────────────────────────┐   │   │
│  │  │           Rook CSI Driver (DaemonSet)        │   │   │
│  │  │  csi-rbdplugin  csi-cephfsplugin            │   │   │
│  │  └─────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌──────────────┐  ┌───────────────┐  ┌─────────────────┐ │
│  │  應用 Pod     │  │  KubeVirt VM  │  │  其他 Workload  │ │
│  │  (PVC→RBD)   │  │  (PVC→RBD)   │  │  (PVC→CephFS)  │ │
│  └──────────────┘  └───────────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 核心元件

### rook-operator

- 單一 Deployment，是整個 Rook 的大腦
- Watch 所有 Rook CRD（CephCluster、CephBlockPool 等）
- 當你 apply 一個 CRD，operator 負責把它變成現實（建立 Pod、設定 Ceph）
- 持續 Reconcile：確保 Ceph Cluster 狀態符合你宣告的 YAML

### Rook CRD（自定義資源）

| CRD | 說明 |
|-----|------|
| `CephCluster` | 整個 Ceph Cluster 的設定（OSD 用哪些磁碟、MON 數量等） |
| `CephBlockPool` | RBD 的 Pool 設定（副本數、Failure Domain） |
| `CephFilesystem` | CephFS 設定（MDS 數量、Pool 設定） |
| `CephObjectStore` | RGW Object Store 設定 |
| `CephObjectStoreUser` | S3 使用者設定 |
| `CephNFS` | NFS 閘道設定 |
| `CephClient` | Ceph 使用者/金鑰管理 |

### Rook CSI Driver

- 實作 Kubernetes CSI（Container Storage Interface）標準
- 讓 k8s 的 PVC 能自動從 Ceph 分配儲存空間
- 包含兩個 plugin：
  - `csi-rbdplugin`：處理 RBD block storage
  - `csi-cephfsplugin`：處理 CephFS
- 以 DaemonSet 形式跑在每個 Node 上

---

## Rook vs 手動安裝 Ceph

| | 手動安裝 Ceph | Rook |
|--|--------------|------|
| 部署方式 | ceph-deploy / Ansible | kubectl apply |
| 擴展 OSD | 手動執行 ceph 指令 | 改 CephCluster YAML |
| 升級 Ceph | 複雜的手動流程 | 改 image tag，operator 處理 |
| 故障恢復 | 手動干預 | operator 自動修復 |
| k8s 整合 | 需要手動建立 StorageClass | 自動建立 |
| 監控 | 手動設定 Prometheus | 內建 ServiceMonitor |

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：Rook Operator 的核心工作是什麼？
**答案：** Rook Operator 是一個 Kubernetes Controller，它的工作是：

1. **Watch** Rook 的 CRD（如 CephCluster、CephBlockPool）
2. **比對**期望狀態（你的 YAML）和現狀（實際 Ceph 狀態）
3. **調整**：建立/刪除/修改 Ceph 元件，讓現狀符合期望

這就是典型的 Kubernetes Reconciliation Loop，和 Deployment Controller 的邏輯完全一樣。
:::

::: details 測驗 2：為什麼 Rook 的 CSI Driver 要用 DaemonSet？
**答案：** CSI Driver 需要在**每個 Node** 上運行，因為：

- 當一個 Pod 被調度到某個 Node 時，需要在那個 Node 上 mount / unmount volume
- CSI Driver 需要在本機執行 `rbd map`（掛載 RBD）或 `mount -t ceph`（掛載 CephFS）等操作
- 這些操作必須在 Pod 所在的 Node 上執行，所以需要 DaemonSet 確保每個 Node 都有 CSI plugin
:::

---

## 實作：查看 Rook 元件狀態

```bash
# 查看所有 Rook 元件
kubectl -n rook-ceph get pod

# 查看 CephCluster 狀態
kubectl -n rook-ceph get cephcluster
# HEALTH 欄位要是 HEALTH_OK

# 查看 Rook operator log
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=50

# 查看所有 Rook CRD
kubectl get crd | grep ceph

# 進入 toolbox 操作 ceph 指令
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph status
```
