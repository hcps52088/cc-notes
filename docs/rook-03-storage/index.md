# Rook 儲存設定完全指南

## 三種儲存類型完整比較

| | Block（RBD） | File（CephFS） | Object（S3） |
|--|------------|--------------|-------------|
| **Rook CRD** | CephBlockPool | CephFilesystem | CephObjectStore |
| **StorageClass** | rook-ceph.rbd.csi.ceph.com | rook-ceph.cephfs.csi.ceph.com | rook-ceph.ceph.rook.io/bucket（OBC） |
| **k8s 資源** | PVC | PVC | ObjectBucketClaim |
| **Access Mode** | RWO（預設）/ RWX（需 rbd-nbd） | RWO / RWX（天生支援） | N/A（HTTP 存取） |
| **volumeMode** | Block（VM 用）/ Filesystem | Filesystem | N/A |
| **快照支援** | ✅ VolumeSnapshot（csi-rbdplugin-snapclass） | ✅ VolumeSnapshot（csi-cephfsplugin-snapclass） | ✅ Object Versioning |
| **線上擴容** | ✅ allowVolumeExpansion | ✅ allowVolumeExpansion | N/A |
| **適合 KubeVirt VM** | ✅ 首選 | ⚠️ 可用，效能差 | ❌ |
| **多 Pod 共用** | ❌（RWO 限制）/ ✅（RWX） | ✅ | ✅（HTTP 方式） |
| **需要的 Ceph daemon** | MON/OSD/MGR | MON/OSD/MGR + MDS | MON/OSD/MGR + RGW |

## 三種儲存類型的設定路徑

```
Rook 支援 Ceph 的三種儲存類型，每種都需要：
CRD（描述 Ceph 資源）+ StorageClass（k8s 整合）+ PVC（實際使用）

Block (RBD)：
  CephBlockPool → StorageClass → PVC (RWO/RWX) → Pod / VM

File (CephFS)：
  CephFilesystem → StorageClass → PVC (RWX) → Pod（多個同時掛載）

Object (S3)：
  CephObjectStore → CephObjectStoreUser → HTTP Endpoint（不走 PVC）
```

---

## Block Storage（RBD）

### CephBlockPool 設定

```yaml
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: replicapool
  namespace: rook-ceph
spec:
  # 故障域：副本分散到不同 host（Node）
  # 可選：host / rack / zone / region
  failureDomain: host

  replicated:
    size: 3           # 副本數：3 份
    requireSafeReplicaSize: true  # 禁止 size < 3 的不安全設定

  # 或使用 Erasure Coding（省空間，效能略低）
  # erasureCoded:
  #   dataChunks: 4   # 資料塊數
  #   codingChunks: 2 # 校驗塊數（可容忍 2 塊損失）

  # 進階：自動調整 PG 數量（需要 pg_autoscaler MGR module）
  parameters:
    pg_autoscale_mode: "on"
```

### StorageClass 設定

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"  # 設為 k8s 預設 SC
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  # Rook Ceph Cluster 的 namespace
  clusterID: rook-ceph

  # 對應的 CephBlockPool 名稱
  pool: replicapool

  # RBD image 格式（固定用 2）
  imageFormat: "2"

  # RBD features（影響功能支援）
  # kernel >= 5.4：可加 deep-flatten,exclusive-lock,object-map,fast-diff
  imageFeatures: layering

  # CSI Secret（Rook 安裝時自動建立）
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph

  # 磁碟加密（選填）
  # encrypted: "true"
  # encryptionKMSID: vault-kms

reclaimPolicy: Delete         # PVC 刪除時自動刪 RBD image
allowVolumeExpansion: true    # 允許線上擴容 PVC
volumeBindingMode: Immediate  # 或 WaitForFirstConsumer（節點感知調度）
```

### PVC 類型比較

=== "ReadWriteOnce（一般 VM 磁碟）"
    ```yaml
    apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: vm-disk-rwo
    spec:
      storageClassName: rook-ceph-block
      accessModes:
        - ReadWriteOnce    # 單一 Node 讀寫
      volumeMode: Block    # 給 VM 用要指定 Block mode
      resources:
        requests:
          storage: 50Gi
    ```

=== "ReadWriteMany（Live Migration 用）"
    ```yaml
    # 需要額外建立支援 RWX 的 StorageClass
    apiVersion: storage.k8s.io/v1
    kind: StorageClass
    metadata:
      name: rook-ceph-block-rwx
    provisioner: rook-ceph.rbd.csi.ceph.com
    parameters:
      clusterID: rook-ceph
      pool: replicapool
      imageFormat: "2"
      imageFeatures: layering
      # RWX 需要指定 mounter
      mounter: rbd-nbd
      csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
      csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
      csi.storage.k8s.io/controller-expand-secret-name: rook-csi-rbd-provisioner
      csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
      csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
      csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
    reclaimPolicy: Delete
    allowVolumeExpansion: true
    ---
    apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: vm-disk-rwx
    spec:
      storageClassName: rook-ceph-block-rwx
      accessModes:
        - ReadWriteMany    # 多 Node 同時掛載，Live Migration 必要
      volumeMode: Block
      resources:
        requests:
          storage: 50Gi
    ```

=== "Filesystem mode（一般應用）"
    ```yaml
    apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: app-data
    spec:
      storageClassName: rook-ceph-block
      accessModes:
        - ReadWriteOnce
      volumeMode: Filesystem    # 預設，自動格式化並掛載
      resources:
        requests:
          storage: 20Gi
    ```

### 線上擴容 PVC

```bash
# 擴容前確認 StorageClass 有 allowVolumeExpansion: true
kubectl get sc rook-ceph-block -o jsonpath='{.allowVolumeExpansion}'

# 直接 patch PVC 大小
kubectl patch pvc vm-disk-rwo -p '{"spec":{"resources":{"requests":{"storage":"100Gi"}}}}'

# 或 kubectl edit
kubectl edit pvc vm-disk-rwo
# 修改 spec.resources.requests.storage

# 確認擴容成功
kubectl get pvc vm-disk-rwo
# CAPACITY 欄位更新後完成

# 若是 Filesystem mode，Pod 重啟後 df -h 就會看到新容量
# Block mode 的 VM 需要在 VM 內部執行 resize2fs 等指令
```

---

## CephFS（共享檔案系統）

### CephFilesystem 設定

```yaml
apiVersion: ceph.rook.io/v1
kind: CephFilesystem
metadata:
  name: myfs
  namespace: rook-ceph
spec:
  # 元資料 Pool（目錄、inode）
  metadataPool:
    replicated:
      size: 3
    failureDomain: host

  # 資料 Pool（實際檔案內容）
  dataPools:
    - name: replicated
      failureDomain: host
      replicated:
        size: 3

  # 保留 Pool（刪除 CephFilesystem 時不刪 Pool）
  preserveFilesystemOnDelete: true

  # Metadata Server (MDS) 設定
  metadataServer:
    activeCount: 1          # Active MDS 數量（大規模可增加）
    activeStandby: true     # 每個 Active 配一個 Standby
    resources:
      limits:
        memory: 4Gi
      requests:
        memory: 4Gi
        cpu: "1"
```

### CephFS StorageClass

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-cephfs
provisioner: rook-ceph.cephfs.csi.ceph.com
parameters:
  clusterID: rook-ceph
  fsName: myfs                   # 對應 CephFilesystem 名稱
  pool: myfs-replicated          # 對應 dataPools 的名稱

  csi.storage.k8s.io/provisioner-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/controller-expand-secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/controller-expand-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-cephfs-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph

reclaimPolicy: Delete
allowVolumeExpansion: true
```

### 多 Pod 共用同一個 PVC（RWX）

```yaml
# PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-data
spec:
  storageClassName: rook-cephfs
  accessModes:
    - ReadWriteMany          # CephFS 天生支援 RWX
  resources:
    requests:
      storage: 100Gi

---
# Deployment：多個 Pod replica 共用同一個 PVC
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-cluster
spec:
  replicas: 3                # 3 個 Pod 同時掛載同一個 PVC
  template:
    spec:
      containers:
        - name: web
          image: nginx
          volumeMounts:
            - name: shared
              mountPath: /var/www/html
      volumes:
        - name: shared
          persistentVolumeClaim:
            claimName: shared-data
```

### SubPath：多個 Pod 用同一 PVC 的不同目錄

```yaml
volumes:
  - name: shared
    persistentVolumeClaim:
      claimName: shared-data

containers:
  - name: app-a
    volumeMounts:
      - name: shared
        mountPath: /data
        subPath: app-a        # 實際掛載 PVC 裡的 /app-a 目錄

  - name: app-b
    volumeMounts:
      - name: shared
        mountPath: /data
        subPath: app-b        # 實際掛載 PVC 裡的 /app-b 目錄
```

---

## Object Storage（S3）

### CephObjectStore 設定

```yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStore
metadata:
  name: my-store
  namespace: rook-ceph
spec:
  # 元資料 Pool
  metadataPool:
    failureDomain: host
    replicated:
      size: 3

  # 資料 Pool
  dataPool:
    failureDomain: host
    replicated:
      size: 3
    # 或使用 EC：
    # erasureCoded:
    #   dataChunks: 4
    #   codingChunks: 2

  # 刪除 ObjectStore 時保留 Pool（避免資料遺失）
  preservePoolsOnDelete: true

  # RGW Gateway 設定
  gateway:
    type: s3
    port: 80            # HTTP
    securePort: 443     # HTTPS（需要 TLS Secret）
    instances: 2        # 2 個 RGW 實例（高可用）
    resources:
      limits:
        memory: 2Gi
      requests:
        memory: 1Gi
        cpu: "500m"
```

### 建立 S3 User

```yaml
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata:
  name: my-user
  namespace: rook-ceph
spec:
  store: my-store          # 對應 CephObjectStore
  displayName: "My S3 User"
  capabilities:
    user: "*"
    bucket: "*"
    metadata: "*"
    usage: "*"
    zone: "*"
```

```bash
# 取得 Access Key 和 Secret Key
ACCESS_KEY=$(kubectl -n rook-ceph get secret \
  rook-ceph-object-user-my-store-my-user \
  -o jsonpath='{.data.AccessKey}' | base64 -d)

SECRET_KEY=$(kubectl -n rook-ceph get secret \
  rook-ceph-object-user-my-store-my-user \
  -o jsonpath='{.data.SecretKey}' | base64 -d)

echo "Access Key: $ACCESS_KEY"
echo "Secret Key: $SECRET_KEY"

# 取得 RGW Service 的 Endpoint
RGW_ENDPOINT=$(kubectl -n rook-ceph get svc \
  rook-ceph-rgw-my-store -o jsonpath='{.spec.clusterIP}')
echo "Endpoint: http://$RGW_ENDPOINT"
```

### 用 AWS CLI 存取

```bash
# 設定 AWS CLI profile
aws configure --profile rook-ceph
# AWS Access Key ID: <access-key>
# AWS Secret Access Key: <secret-key>
# Default region: us-east-1
# Default output format: json

# 操作 Bucket
aws --profile rook-ceph --endpoint-url http://$RGW_ENDPOINT \
  s3 mb s3://my-bucket

aws --profile rook-ceph --endpoint-url http://$RGW_ENDPOINT \
  s3 ls

aws --profile rook-ceph --endpoint-url http://$RGW_ENDPOINT \
  s3 cp /etc/hosts s3://my-bucket/test.txt

aws --profile rook-ceph --endpoint-url http://$RGW_ENDPOINT \
  s3 ls s3://my-bucket
```

### ObjectBucketClaim（讓 App 自動申請 Bucket）

類似 PVC 申請 Volume，OBC 讓應用自動申請 S3 Bucket：

```yaml
# 先建立 StorageClass（Object Bucket 用）
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-bucket
provisioner: rook-ceph.ceph.rook.io/bucket
reclaimPolicy: Delete
parameters:
  objectStoreName: my-store
  objectStoreNamespace: rook-ceph

---
# App 申請一個 Bucket
apiVersion: objectbucket.io/v1alpha1
kind: ObjectBucketClaim
metadata:
  name: my-app-bucket
spec:
  storageClassName: rook-ceph-bucket
  generateBucketName: my-app    # 自動產生唯一 Bucket 名稱
```

```bash
# Rook 自動建立 ConfigMap（Bucket 資訊）和 Secret（金鑰）
kubectl get configmap my-app-bucket -o yaml
# BUCKET_HOST、BUCKET_PORT、BUCKET_NAME

kubectl get secret my-app-bucket -o yaml
# AWS_ACCESS_KEY_ID、AWS_SECRET_ACCESS_KEY
```

---

## Volume Snapshot（快照）

### Snapshot vs Clone vs Backup 比較

| | VolumeSnapshot | PVC Clone | 外部備份（Velero） |
|--|---------------|-----------|-----------------|
| **原理** | Ceph RBD/CephFS 快照 | RBD Copy-on-Write 複製 | 資料導出到 Object Storage |
| **建立速度** | 瞬間（COW） | 瞬間（COW） | 慢（需要傳輸資料） |
| **儲存佔用** | 小（只記錄差異） | 初始很小（COW） | 完整副本 |
| **跨 Cluster 還原** | ❌（Ceph 快照不能跨 cluster） | ❌ | ✅ |
| **適合場景** | 升級前備份、快速還原 | 快速建多個測試 VM | 災難還原、跨 cluster 搬移 |
| **k8s 資源** | VolumeSnapshot | PVC（dataSource: PVC） | Backup CR |

Snapshot 讓你在某個時間點「凍結」PVC 狀態，之後可以還原或從快照建立新 PVC。

### 前提：安裝 Snapshot Controller

```bash
# 安裝 snapshot CRD 和 controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/master/client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/master/client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/master/client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/master/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/master/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml
```

### VolumeSnapshotClass

```yaml
# Block Storage (RBD) 的 SnapshotClass
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-rbdplugin-snapclass
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: rook-ceph.rbd.csi.ceph.com
deletionPolicy: Delete
parameters:
  clusterID: rook-ceph
  csi.storage.k8s.io/volumesnapshot/secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/volumesnapshot/secret-namespace: rook-ceph

---
# CephFS 的 SnapshotClass
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-cephfsplugin-snapclass
driver: rook-ceph.cephfs.csi.ceph.com
deletionPolicy: Delete
parameters:
  clusterID: rook-ceph
  csi.storage.k8s.io/volumesnapshot/secret-name: rook-csi-cephfs-provisioner
  csi.storage.k8s.io/volumesnapshot/secret-namespace: rook-ceph
```

### 建立快照

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: my-pvc-snapshot
spec:
  volumeSnapshotClassName: csi-rbdplugin-snapclass
  source:
    persistentVolumeClaimName: vm-disk-rwo    # 要快照的 PVC
```

```bash
# 等待快照完成
kubectl get volumesnapshot my-pvc-snapshot
# READYTOUSE: true

kubectl describe volumesnapshot my-pvc-snapshot
```

### 從快照還原（建立新 PVC）

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vm-disk-restored
spec:
  storageClassName: rook-ceph-block
  dataSource:
    name: my-pvc-snapshot           # 從這個 Snapshot 還原
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
    - ReadWriteOnce
  volumeMode: Block
  resources:
    requests:
      storage: 50Gi                 # 不能小於原始 PVC 大小
```

### PVC Clone（直接複製）

不需要 Snapshot，直接從現有 PVC 複製一份：

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vm-disk-clone
spec:
  storageClassName: rook-ceph-block
  dataSource:
    name: vm-disk-rwo               # 來源 PVC
    kind: PersistentVolumeClaim
  accessModes:
    - ReadWriteOnce
  volumeMode: Block
  resources:
    requests:
      storage: 50Gi
```

!!! tip "Clone 的實作原理"
    Ceph RBD 的 Clone 使用**Copy-on-Write**，Clone 建立瞬間完成（不需要複製資料）。只有當 Clone 裡的某個 block 被修改時，才真正複製那個 block。這讓大量 VM 共用一個 base image 成為可能。

---

## Rook 儲存設定完整速查

### 常用指令

```bash
# 進入 toolbox
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash

# 查看所有 Pool
ceph osd pool ls detail

# 查看 Pool 的副本數和 PG 數
ceph osd pool get replicapool size
ceph osd pool get replicapool pg_num

# 查看 Pool 容量使用率
ceph df

# 查看 RBD image 列表
rbd ls -p replicapool

# 查看特定 RBD image 的詳細資訊
rbd info replicapool/csi-vol-xxx

# 查看 CephFS 狀態
ceph fs ls
ceph fs status myfs

# 查看 Object Store 狀態
radosgw-admin zone list
radosgw-admin user list
```

### Rook CRD 快速查看

```bash
# 查看所有 Rook 資源
kubectl -n rook-ceph get cephblockpool
kubectl -n rook-ceph get cephfilesystem
kubectl -n rook-ceph get cephobjectstore
kubectl -n rook-ceph get cephobjectstoreuser

# 查看 StorageClass
kubectl get sc | grep rook

# 查看 VolumeSnapshotClass
kubectl get volumesnapshotclass

# 查看所有 PVC 和對應的 PV
kubectl get pvc --all-namespaces
kubectl get pv
```

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：`reclaimPolicy: Delete` 和 `Retain` 有什麼差異？什麼時候用 Retain？
**答案：**

- **Delete**：PVC 刪除後，Ceph 裡對應的 RBD image 也一起刪除。資料永久消失。
- **Retain**：PVC 刪除後，PV 和 Ceph 裡的 RBD image 繼續存在（變成 `Released` 狀態），可以手動回收或重新綁定。

**什麼時候用 Retain？**
- 生產環境的重要 VM 磁碟（防止誤刪 PVC 導致資料消失）
- 需要跨 namespace 遷移資料的場景

用法：建立 StorageClass 時設定 `reclaimPolicy: Retain`，或在建立 PVC 後手動 patch PV 的 `reclaimPolicy`。
:::

::: details 測驗 2：PVC 的 `volumeMode: Block` 和 `Filesystem` 有什麼差異？KubeVirt VM 需要哪種？
**答案：**

- **Filesystem**（預設）：Rook CSI 把 RBD image 格式化成 ext4/xfs，再 mount 進 Pod，Pod 看到的是一個目錄
- **Block**：直接把 raw block device（RBD image）暴露給 Pod，Pod 看到的是 `/dev/xxx`，需要自己管理格式化

**KubeVirt VM 要用 Block mode：**

QEMU/KVM 需要 raw block device 才能模擬虛擬磁碟。如果是 Filesystem mode，QEMU 只能把整個目錄看成一個 image 檔，效能和功能都受限。Block mode 讓 QEMU 直接操作 block device，效能最好。
:::

::: details 測驗 3：Snapshot 和 Clone 的差異是什麼？什麼時候用哪個？
**答案：**

**Snapshot（快照）：**
- 記錄某個時間點的狀態
- 可以多次還原到同一個時間點
- 適合：定期備份、升級前保存狀態

**Clone（複製）：**
- 從現有 PVC 建立一個獨立副本
- 底層用 Copy-on-Write，建立瞬間完成
- 副本之後獨立演化，互不影響

**使用場景：**
- 要備份 → 用 Snapshot
- 要快速建立多個相同的 VM（golden image 模式）→ 先建 Snapshot，再從 Snapshot Clone 多份
- 要一個一次性的副本做測試 → 直接 Clone
:::

::: details 測驗 4：CephFS 和 RBD 的 StorageClass 都可以建立 RWX 的 PVC，但適用場景不同，怎麼選？
**答案：**

| | CephFS RWX | RBD RWX |
|--|-----------|---------|
| 性能 | 較低（需要 MDS） | 較高 |
| 使用場景 | 多 Pod 共享目錄 | KubeVirt VM Live Migration |
| 存取語意 | POSIX 檔案系統 | Raw block device |
| 設定複雜度 | 簡單（天生支援） | 需要 `mounter: rbd-nbd` |

**選擇原則：**
- 多個 Pod 要共享一個目錄 → CephFS RWX
- KubeVirt VM 需要 Live Migration → RBD RWX（`mounter: rbd-nbd`）
- 一般 VM 磁碟（不 Migrate）→ RBD RWO 就夠了
:::

---

## 實作：完整儲存驗證流程

```bash
# === 1. 確認所有 StorageClass 就緒 ===
kubectl get sc
# rook-ceph-block   rook-ceph.rbd.csi.ceph.com   Delete   Immediate   true
# rook-cephfs       rook-ceph.cephfs.csi.ceph.com Delete   Immediate   false

# === 2. 測試 RBD PVC ===
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-rbd
spec:
  storageClassName: rook-ceph-block
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
EOF

kubectl get pvc test-rbd
# STATUS: Bound ← 成功

# === 3. 測試 CephFS PVC ===
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-cephfs
spec:
  storageClassName: rook-cephfs
  accessModes: [ReadWriteMany]
  resources:
    requests:
      storage: 1Gi
EOF

kubectl get pvc test-cephfs
# STATUS: Bound ← 成功

# === 4. 寫入測試資料到 RBD ===
kubectl run rbd-test --image=busybox --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"rbd-test","image":"busybox","command":["sh","-c","echo hello-rbd > /data/test.txt && cat /data/test.txt && sleep 3600"],"volumeMounts":[{"mountPath":"/data","name":"vol"}]}],"volumes":[{"name":"vol","persistentVolumeClaim":{"claimName":"test-rbd"}}]}}' 

kubectl logs rbd-test
# hello-rbd

# === 5. 測試 Snapshot ===
kubectl apply -f - <<'EOF'
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: test-rbd-snap
spec:
  volumeSnapshotClassName: csi-rbdplugin-snapclass
  source:
    persistentVolumeClaimName: test-rbd
EOF

kubectl get volumesnapshot test-rbd-snap
# READYTOUSE: true

# === 6. 從 Snapshot 還原新 PVC ===
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-rbd-restored
spec:
  storageClassName: rook-ceph-block
  dataSource:
    name: test-rbd-snap
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 1Gi
EOF

# 掛載 restored PVC 確認資料在
kubectl run restore-test --image=busybox --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"t","image":"busybox","command":["cat","/data/test.txt"],"volumeMounts":[{"mountPath":"/data","name":"v"}]}],"volumes":[{"name":"v","persistentVolumeClaim":{"claimName":"test-rbd-restored"}}]}}'

kubectl logs restore-test
# hello-rbd ← 資料完整還原 ✅

# === 7. 清理 ===
kubectl delete pvc test-rbd test-cephfs test-rbd-restored
kubectl delete volumesnapshot test-rbd-snap
kubectl delete pod rbd-test restore-test
```
