# Rook 架構概覽

## Rook 是什麼？

Rook 是 **Ceph 的 Kubernetes Operator**，把「用 `kubectl apply` 管理 Ceph Cluster」這件事變成可能。它不是 Ceph 的 fork，也不改變 Ceph 本身，而是在 Ceph 外層包了一個 k8s 的大腦。

```
傳統 Ceph 部署（Ansible / ceph-deploy）：
  你 → 手動執行 ceph 指令 → Ceph Cluster

Rook 方式：
  你 → kubectl apply CephCluster YAML → Rook Operator → Ceph Cluster
```

**Rook 是 CNCF Graduated 專案**（2020 年畢業），和 Kubernetes、Prometheus、Argo 同等級。

---

## 整體架構

```
┌───────────────────────────────────────────────────────────────────┐
│                       Kubernetes Cluster                           │
│                                                                   │
│  ┌───────────────────────── rook-ceph namespace ────────────────┐ │
│  │                                                               │ │
│  │  ┌──────────────────────┐   ┌───────────────────────────┐   │ │
│  │  │   rook-ceph-operator │   │      Ceph Cluster          │   │ │
│  │  │   (Deployment × 1)  │   │                           │   │ │
│  │  │                     │   │  ceph-mon-a/b/c (Pod)     │   │ │
│  │  │  Watch CRD          │   │  ceph-mgr-a/b  (Pod)      │   │ │
│  │  │  Reconcile          │──▶│  ceph-osd-0..N (Pod)      │   │ │
│  │  │  Manage Ceph        │   │  ceph-mds-*    (Pod)      │   │ │
│  │  │                     │   │  ceph-rgw-*    (Pod)      │   │ │
│  │  └──────────────────────┘   └───────────────────────────┘   │ │
│  │                                                               │ │
│  │  ┌────────────────────────────────────────────────────────┐  │ │
│  │  │           CSI Driver Pods（DaemonSet per Node）         │  │ │
│  │  │  csi-rbdplugin-*       csi-cephfsplugin-*              │  │ │
│  │  │  csi-rbdplugin-provisioner  csi-cephfsplugin-provisioner│  │ │
│  │  └────────────────────────────────────────────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                    k8s API Resources                         │ │
│  │  StorageClass  PersistentVolume  PersistentVolumeClaim       │ │
│  │  VolumeSnapshot  VolumeSnapshotContent                       │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌──────────────┐  ┌───────────────┐  ┌─────────────────────┐   │
│  │  App Pod      │  │  KubeVirt VM  │  │  StatefulSet DB      │   │
│  │  PVC→CephFS   │  │  PVC→RBD     │  │  PVC→RBD             │   │
│  └──────────────┘  └───────────────┘  └─────────────────────┘   │
└───────────────────────────────────────────────────────────────────┘
```

---

## 核心元件

### rook-ceph-operator（大腦）

Rook 的核心是一個跑在 k8s 上的 **Controller**（Deployment，只有 1 個 replica + leader election）。它的工作：

```
1. Watch 所有 Rook CRD（CephCluster、CephBlockPool 等）
   ↓ 有變化時
2. 呼叫 Ceph 的 Admin API 做設定（等同於手動執行 ceph 指令）
3. 建立 / 修改 / 刪除對應的 Ceph Pod（Mon、OSD、MGR...）
4. 建立 StorageClass、Secret（Ceph 認證金鑰）供 CSI 使用
5. 回報狀態到 CRD 的 status 欄位
```

這是標準的 **Kubernetes Operator Pattern**，和 Prometheus Operator、cert-manager 原理完全一樣。

### Rook CRD（你寫的 YAML）

| CRD | 說明 | 等同的 ceph 操作 |
|-----|------|----------------|
| `CephCluster` | 整個 Cluster：OSD 用哪些磁碟、MON 數量、網路設定 | `ceph-deploy` / `cephadm bootstrap` |
| `CephBlockPool` | RBD Pool 設定（副本數、Failure Domain） | `ceph osd pool create` |
| `CephFilesystem` | CephFS 設定（MDS 數量、Pool） | `ceph fs new` |
| `CephObjectStore` | RGW 設定（S3 入口） | `radosgw-admin zone create` |
| `CephObjectStoreUser` | S3 使用者 | `radosgw-admin user create` |
| `CephNFS` | NFS Gateway | `ceph nfs cluster create` |
| `CephClient` | Ceph 使用者和 keyring | `ceph auth add` |
| `CephRBDMirror` | 跨 Cluster 的 RBD 鏡像（DR 用） | `rbd mirror pool enable` |

### Rook CSI Driver（存取 Ceph 的橋樑）

CSI（Container Storage Interface）是 k8s 的標準插件介面，讓 k8s 和各種存儲系統整合。

Rook 的 CSI Driver 有兩種：

```
csi-rbdplugin：
  處理 RBD block storage（PVC → Ceph RBD image）

csi-cephfsplugin：
  處理 CephFS（PVC → CephFS 目錄）
```

每種 CSI 分成兩個部分：

```
Provisioner（Deployment）：
  - 處理 PVC 建立 / 刪除（向 Ceph 申請 / 釋放 RBD image）
  - 處理 VolumeSnapshot 建立 / 刪除
  - 只需要一個 active 實例

Node Plugin（DaemonSet）：
  - 在每個 Node 上執行 mount / unmount（rbd map / rbd unmap）
  - 必須跑在 Pod 所在的 Node，所以用 DaemonSet
```

### PVC 從申請到掛載的流程

```
1. 使用者 kubectl apply PVC（storageClassName: rook-ceph-block）

2. k8s PersistentVolume Controller 找到對應的 StorageClass
   → 呼叫 CSI Provisioner

3. CSI Provisioner（rook-ceph）
   → 向 Ceph 建立一個 RBD image（rbd create）
   → 建立 PersistentVolume 物件（綁定 PVC）

4. Pod 被調度到 Node，需要掛載 PVC

5. CSI Node Plugin（該 Node 上的 DaemonSet Pod）
   → 執行 rbd map（把 RBD image 對應到 /dev/rbdX）
   → 掛載 /dev/rbdX 到指定路徑

6. Pod container 啟動，看到掛載好的 Volume ✅
```

---

## Rook vs 手動安裝 Ceph

| | 手動安裝 Ceph | Rook |
|--|--------------|------|
| **部署** | `ceph-deploy` / `cephadm` / Ansible | `kubectl apply -f cluster.yaml` |
| **新增 OSD** | SSH 到 Node 執行 `ceph orch add osd` | 改 `CephCluster` 的 `storageDeviceSets` |
| **升級 Ceph** | 複雜：逐個 daemon 升級，有順序要求 | 改 `spec.cephVersion.image`，operator 自動滾動升級 |
| **故障恢復** | 手動執行 ceph 指令找問題 | operator 自動偵測並修復（重建 Pod） |
| **k8s 整合** | 手動建立 StorageClass、Secret | 自動建立，和 k8s PVC 完全整合 |
| **監控** | 手動設定 Prometheus + Grafana | 內建 ServiceMonitor，Rook Dashboard |
| **學習曲線** | 需要深入了解 Ceph 內部 | 只需要知道 CRD 的 spec 欄位 |
| **靈活性** | 完全控制 | 受限於 operator 支援的設定 |

---

## Rook 的 Operator Pattern 詳解

理解 Rook 就是理解 Kubernetes Operator 模式：

```
┌──────────────────────────────────────────────────────────────┐
│                    Operator 的工作循環                        │
│                                                              │
│  你 apply CephCluster YAML                                   │
│         │                                                    │
│         ▼                                                    │
│  API Server 儲存到 etcd（作為「期望狀態」）                   │
│         │                                                    │
│         ▼ Watch 事件觸發                                     │
│  Rook Operator 的 Reconcile() 函數被呼叫                     │
│         │                                                    │
│         ├── 讀取 CephCluster spec（期望）                    │
│         ├── 查看目前 Ceph 狀態（現狀）                       │
│         ├── 比對差異                                         │
│         └── 採取行動（建立 Pod、設定 Ceph）                  │
│                  │                                           │
│                  ▼                                           │
│         更新 CephCluster status 欄位                         │
│         （HEALTH_OK / HEALTH_WARN / HEALTH_ERR）             │
│                  │                                           │
│                  ▼ 任何變化都重新觸發 Watch                  │
│         下次 Reconcile 確認 ✅                               │
└──────────────────────────────────────────────────────────────┘
```

Rook Operator 的 Reconcile 是**冪等的**（Idempotent）：無論執行幾次，結果都一樣。這讓它可以安全地在任何時候重啟 operator，不用擔心造成重複操作。

---

## 磁碟管理策略

Rook 支援三種方式設定 OSD 使用的磁碟：

```yaml
spec:
  storage:
    # 方式 1：用特定磁碟設備
    useAllNodes: false
    nodes:
      - name: "node1"
        devices:
          - name: "sdb"
          - name: "sdc"

    # 方式 2：自動用所有 Node 上符合條件的磁碟
    useAllNodes: true
    useAllDevices: false
    deviceFilter: "^sd[b-z]"     # regex：sdb、sdc...sdz
    devicePathFilter: "^/dev/disk/by-id/ata.*"

    # 方式 3：用 PVC（適合雲端環境，用 EBS/PD 作為 OSD）
    storageClassDeviceSets:
      - name: set1
        count: 3
        volumeClaimTemplates:
          - spec:
              storageClassName: gp2    # 用 AWS EBS
              resources:
                requests:
                  storage: 1Ti
```

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：Rook Operator 和 Ceph 本身的關係是什麼？Rook 是不是 Ceph 的 fork？
**答案：**

Rook **不是** Ceph 的 fork。Rook 和 Ceph 是完全分離的兩個專案：

- **Ceph**：分散式儲存系統，本體，有自己的 daemon（mon、osd、mgr 等）
- **Rook**：Ceph 的 Kubernetes Operator，是一個控制層，負責在 k8s 上管理 Ceph 的生命週期

Rook 使用標準的 Ceph API（呼叫 `ceph` CLI、Ceph Admin API）來管理 Ceph，就像 Ansible playbook 管理 Ceph 一樣，只是包裝成了 k8s Controller。升級 Ceph 版本只需要改 `spec.cephVersion.image`，Rook 自己不包含 Ceph 程式碼。
:::

::: details 測驗 2：CSI Provisioner 和 CSI Node Plugin 為什麼一個用 Deployment、一個用 DaemonSet？
**答案：**

**Provisioner**（Deployment）：
- 負責 PVC 的建立和刪除（向 Ceph 申請 RBD image）
- 這個操作**不需要在特定 Node 上執行**，在任何地方呼叫 Ceph API 都可以
- 只需要一個 active 實例（避免重複建立）

**Node Plugin**（DaemonSet）：
- 負責在 Node 上執行 `rbd map`（把 RBD image attach 到 /dev/rbdX）和 `mount`
- 這些操作必須**在 Pod 所在的 Node 上執行**，因為 mount 是 Node 本地操作
- 所以每個 Node 都必須有一個，用 DaemonSet 確保覆蓋率

類比：快遞公司（Provisioner）負責從倉庫調貨，但「把包裹搬進你家門」（Node Plugin）必須在你家附近的配送員（在你的 Node 上）才能做到。
:::

::: details 測驗 3：如果 rook-ceph-operator Pod 重啟，Ceph Cluster 會停止運作嗎？
**答案：**

**不會**。Ceph Cluster 繼續正常運作，因為：

- Rook Operator 只是**管理面**（control plane），負責設定和監控 Ceph
- Ceph 的 Mon、OSD、MGR 等 daemon 是獨立的 Pod，不依賴 Operator 運作
- Operator 重啟只是暫時失去自動修復能力（期間若 Ceph Pod 崩潰，不會被自動重建）
- Operator 重啟後，Reconcile Loop 重新執行，確認現狀並修復任何不一致

這和 k8s 本身的設計一致：`kube-controller-manager` 重啟期間，已在跑的 Pod 不會停止。
:::

::: details 測驗 4：Rook 的 `useAllDevices: true` 設定有什麼風險？
**答案：**

風險：Rook 會把 Node 上**所有未使用的磁碟**都格式化成 Ceph OSD 使用，包括你不想讓它動的磁碟。

**可能的後果：**
- 意外格式化暫時未掛載的重要磁碟
- 把 Cloud Provider attach 的臨時磁碟（如 AWS instance store）也用掉
- 新增一塊磁碟到 Node 後，Rook 立刻格式化它，你沒有機會先備份

**最佳實踐：**
- 不用 `useAllDevices: true`，改用 `deviceFilter` 正規表達式，或明確列出磁碟名稱
- 用 `/dev/disk/by-id/` 路徑取代 `/dev/sdX`（磁碟名稱可能因重開機改變）
- 在 Cloud 環境用 `storageClassDeviceSets` 動態申請 PVC 作為 OSD，完全避免磁碟名稱問題
:::

---

## 實作：確認 Rook 安裝狀態

```bash
# === 確認 Rook Operator 和 Ceph 元件 ===
kubectl -n rook-ceph get pods -o wide

# 正常的輸出應包含：
# rook-ceph-operator-xxx           Running
# rook-ceph-mon-a-xxx              Running
# rook-ceph-mon-b-xxx              Running
# rook-ceph-mon-c-xxx              Running
# rook-ceph-mgr-a-xxx              Running
# rook-ceph-osd-0-xxx              Running
# rook-ceph-osd-1-xxx              Running
# rook-ceph-tools-xxx              Running
# csi-rbdplugin-xxx（每個 Node 一個）Running
# csi-cephfsplugin-xxx（每個 Node 一個）Running

# === 確認 CephCluster 狀態 ===
kubectl -n rook-ceph get cephcluster
# HEALTH 欄位要是 HEALTH_OK

kubectl -n rook-ceph describe cephcluster rook-ceph
# 查看 Status.Ceph.Health 和 Conditions

# === 進入 toolbox 查看 Ceph 內部 ===
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash

## 在 toolbox 裡執行：
ceph status          # 整體狀態
ceph osd status      # OSD 列表和狀態
ceph osd tree        # 顯示 CRUSH 樹狀結構
ceph df              # 容量使用率
ceph health detail   # 詳細的警告訊息

# === 查看所有 Rook CRD ===
kubectl get crd | grep ceph.rook.io

# === 確認 StorageClass 建立成功 ===
kubectl get storageclass | grep rook

# === 確認 CSI Driver 註冊成功 ===
kubectl get csidrivers | grep ceph

# === 查看 Operator log（debug 用）===
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=50 -f
```
