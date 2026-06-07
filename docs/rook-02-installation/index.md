# Rook 安裝與設定

## 前提條件

### 硬體需求

| 項目 | 最低需求 | 建議 |
|------|---------|------|
| Kubernetes 版本 | v1.28+ | 最新穩定版（Rook v1.17 支援 v1.28–v1.33） |
| 節點數 | 3（OSD 分散到不同 Host） | 3+ |
| 每節點 CPU | 2 core | 4+ core |
| 每節點記憶體 | 8 GiB | 16+ GiB |
| 原始磁碟 | 1 顆（未格式化） | 每節點 2+ 顆 |

### 磁碟需求（重要）

OSD 需要**原始、未格式化、未掛載**的磁碟：

```bash
# 確認磁碟是否乾淨（沒有 filesystem）
lsblk -f
# 沒有 FSTYPE 的磁碟才能給 Rook 用

# 如果磁碟之前有用過，需要清除
DISK=/dev/sdb
sgdisk --zap-all $DISK
dd if=/dev/zero of=$DISK bs=1M count=100
blkdiscard $DISK
```

---

## 安裝步驟

### 步驟 1：Clone Rook 設定檔

```bash
export ROOK_VERSION=v1.17.0
git clone --single-branch --branch ${ROOK_VERSION} https://github.com/rook/rook.git
cd rook/deploy/examples
```

### 步驟 2：安裝 CRD 和 Operator

```bash
# 安裝 CRD
kubectl create -f crds.yaml

# 安裝共用 RBAC 等設定
kubectl create -f common.yaml

# 安裝 CSI Operator（管理 CSI Driver）
kubectl create -f csi-operator.yaml

# 安裝 Rook Operator
kubectl create -f operator.yaml

# 等待 Operator 就緒
kubectl -n rook-ceph rollout status deploy/rook-ceph-operator
```

### 步驟 3：建立 Ceph Cluster

選擇適合的 cluster 設定：

=== "生產環境（裸機）"
    ```bash
    kubectl create -f cluster.yaml
    ```
    需要 3 個 Node，每個 Node 至少 1 顆原始磁碟。

=== "測試環境（單節點）"
    ```bash
    kubectl create -f cluster-test.yaml
    ```
    適合 minikube / kind 等本機測試。

=== "雲端環境（用 PVC 當 OSD）"
    ```bash
    kubectl create -f cluster-on-pvc.yaml
    ```
    適合沒有裸機磁碟的雲端環境，用現有 PVC 當 OSD。

### 步驟 4：等待 Cluster 就緒

```bash
# 查看 Pod 狀態（需要幾分鐘）
watch kubectl -n rook-ceph get pod

# 正常狀態應該看到：
# rook-ceph-mon-a-xxx        Running
# rook-ceph-mon-b-xxx        Running
# rook-ceph-mon-c-xxx        Running
# rook-ceph-mgr-a-xxx        Running
# rook-ceph-osd-0-xxx        Running（每顆磁碟一個）
# rook-ceph-osd-1-xxx        Running
# ...

# 確認 CephCluster 狀態
kubectl -n rook-ceph get cephcluster
# HEALTH: HEALTH_OK
# PHASE: Ready
```

### 步驟 5：安裝 Toolbox（管理工具）

```bash
kubectl create -f toolbox.yaml

# 進入 toolbox
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash

# 確認 Ceph 狀態
ceph status
```

---

## cluster.yaml 關鍵設定說明

```yaml
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  cephVersion:
    image: quay.io/ceph/ceph:v19     # Ceph 版本

  # 資料存放路徑（Ceph 元資料）
  dataDirHostPath: /var/lib/rook

  mon:
    count: 3                          # MON 數量（建議奇數）
    allowMultiplePerNode: false       # 不允許多個 MON 在同一 Node

  mgr:
    count: 2                          # MGR 數量（Active + Standby）
    modules:
      - name: pg_autoscaler
        enabled: true                 # 自動調整 PG 數量

  dashboard:
    enabled: true                     # 啟用 Ceph Dashboard
    ssl: true

  monitoring:
    enabled: true                     # 啟用 Prometheus 監控

  storage:
    useAllNodes: true                 # 使用所有 Node 的磁碟
    useAllDevices: true               # 使用所有未格式化磁碟

    # 或者明確指定：
    # nodes:
    #   - name: node1
    #     devices:
    #       - name: sdb
    #       - name: sdc
    #   - name: node2
    #     devices:
    #       - name: sdb
```

---

## 建立 StorageClass

安裝完 Cluster 後，建立讓 k8s 使用的 StorageClass：

```bash
# Block Storage（RBD）
kubectl create -f csi/rbd/storageclass.yaml

# 或直接 apply
kubectl apply -f - <<'EOF'
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: replicapool
  namespace: rook-ceph
spec:
  failureDomain: host
  replicated:
    size: 3
---
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"  # 設為預設 StorageClass
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: replicapool
  imageFormat: "2"
  imageFeatures: layering
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
reclaimPolicy: Delete
allowVolumeExpansion: true
EOF
```

---

## 常見問題排查

```bash
# OSD 沒有啟動 → 查看 OSD prepare job
kubectl -n rook-ceph get job | grep prepare
kubectl -n rook-ceph logs job/rook-ceph-osd-prepare-node1

# CephCluster 一直 Progressing → 查看 operator log
kubectl -n rook-ceph logs deploy/rook-ceph-operator | tail -50

# PVC 一直 Pending → 確認 StorageClass 和 CSI Driver
kubectl describe pvc <pvc-name>
kubectl -n rook-ceph get pod | grep csi
```

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：為什麼 OSD 需要「未格式化」的磁碟？
**答案：** Ceph OSD 使用自己的**BlueStore**格式直接管理磁碟，不依賴作業系統的 filesystem。

如果磁碟已經有 ext4 / xfs 等 filesystem，Rook 不知道這個 filesystem 是不是有重要資料，所以不會動它（避免資料遺失）。必須是乾淨的磁碟，Rook 才會格式化成 BlueStore 格式並建立 OSD。
:::

::: details 測驗 2：cluster.yaml 的 `failureDomain: host` 是什麼意思？
**答案：** 告訴 CRUSH 演算法，**把每個副本分散到不同的 Host（Node）**。

這樣的效果是：即使某一台 Node 完全故障，其他 Node 上仍有完整的副本，資料不會遺失。如果改成 `failureDomain: rack`，則副本會分散到不同機架，可以容忍整個機架斷電。
:::

---

## 實作：完整安裝流程（測試環境）

```bash
# 使用 minikube 測試（需要額外磁碟）
minikube start --nodes=3 --driver=virtualbox

# 給每個 Node 加一顆虛擬磁碟
# （或用 cluster-test.yaml 的 hostPath 模式）

# Clone Rook
git clone --single-branch --branch v1.17.0 https://github.com/rook/rook.git
cd rook/deploy/examples

# 安裝
kubectl create -f crds.yaml -f common.yaml -f csi-operator.yaml -f operator.yaml

# 等 operator 就緒
kubectl -n rook-ceph rollout status deploy/rook-ceph-operator

# 建立測試 cluster
kubectl create -f cluster-test.yaml

# 查看狀態（需要 3-5 分鐘）
watch kubectl -n rook-ceph get pod

# 安裝 toolbox
kubectl create -f toolbox.yaml
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph status
```
