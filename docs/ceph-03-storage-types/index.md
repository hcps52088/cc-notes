# Ceph 三種儲存類型

## 選擇指南

```
需要什麼？
│
├── 給 VM 或 Database 用的磁碟？  → RBD（Block）
├── 多個 Pod 共享讀寫？           → CephFS（File）
└── 備份、圖片、大檔案？          → RGW（Object）
```

---

## RBD（RADOS Block Device）

RBD 把 Ceph 的分散式儲存包裝成一個**虛擬磁碟**，格式化後就像普通硬碟一樣使用。

### 特性

- 支援**精簡配置（Thin Provisioning）**：宣告 100GB，用多少算多少
- 支援**快照（Snapshot）**和**克隆（Clone）**
- 資料自動分條（Striping）到多個 OSD，並行讀寫提升效能
- 支援 QEMU/KVM 直接整合（**KubeVirt VM 的主要儲存**）

### 在 k8s 中使用（透過 Rook）

```yaml
# 1. 建立 CephBlockPool
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
# 2. 建立 StorageClass
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: replicapool
  imageFormat: "2"
  imageFeatures: layering
reclaimPolicy: Delete
allowVolumeExpansion: true

---
# 3. 建立 PVC
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-vm-disk
spec:
  storageClassName: rook-ceph-block
  accessModes:
    - ReadWriteOnce          # 或 ReadWriteMany（需要 RWX pool）
  volumeMode: Block          # Block mode 給 KubeVirt VM
  resources:
    requests:
      storage: 20Gi
```

### 給 KubeVirt VM 用

```yaml
# KubeVirt VM 引用 RBD PVC
apiVersion: kubevirt.io/v1
kind: VirtualMachine
spec:
  template:
    spec:
      domain:
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: virtio
      volumes:
        - name: rootdisk
          persistentVolumeClaim:
            claimName: my-vm-disk   # 由 rook-ceph-block StorageClass 建立
```

---

## CephFS（Ceph File System）

CephFS 提供 **POSIX 相容的分散式檔案系統**，支援多個 Client 同時讀寫同一個目錄。

### 特性

- **RWX（ReadWriteMany）**：多個 Pod 同時讀寫
- POSIX 相容：支援 `open()`、`read()`、`write()`、`flock()` 等
- 元資料（目錄、權限）由 MDS 管理，實際資料在 OSD
- 支援 ACL、quota

### 架構

```
Client（Pod）
    │ 掛載 CephFS
    ▼
MDS（Metadata Server）
    │ 查詢/更新 目錄、inode
    ▼
OSD（實際資料）
```

### 在 k8s 中使用（透過 Rook）

```yaml
# 1. 建立 CephFilesystem
apiVersion: ceph.rook.io/v1
kind: CephFilesystem
metadata:
  name: myfs
  namespace: rook-ceph
spec:
  metadataPool:
    replicated:
      size: 3
  dataPools:
    - name: replicated
      replicated:
        size: 3
  metadataServer:
    activeCount: 1
    activeStandby: true     # 有一個 Standby MDS

---
# 2. 建立 StorageClass
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-cephfs
provisioner: rook-ceph.cephfs.csi.ceph.com
parameters:
  clusterID: rook-ceph
  fsName: myfs
  pool: myfs-replicated
reclaimPolicy: Delete
allowVolumeExpansion: true

---
# 3. 建立 RWX PVC（讓多個 Pod 共用）
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-storage
spec:
  storageClassName: rook-cephfs
  accessModes:
    - ReadWriteMany          # 多個 Pod 同時讀寫
  resources:
    requests:
      storage: 50Gi
```

---

## RGW（RADOS Gateway / Object Storage）

RGW 提供 **S3 相容**的 Object Storage，可以用 AWS SDK 或 `aws s3` CLI 直接存取。

### 特性

- S3 / OpenStack Swift 相容 API
- 支援 Bucket、Object、Multipart Upload
- 支援 Lifecycle（自動刪除舊 Object）
- 適合備份、靜態資源、大量小檔案

### 在 k8s 中使用（透過 Rook）

```yaml
# 1. 建立 CephObjectStore
apiVersion: ceph.rook.io/v1
kind: CephObjectStore
metadata:
  name: my-store
  namespace: rook-ceph
spec:
  metadataPool:
    replicated:
      size: 3
  dataPool:
    replicated:
      size: 3
  preservePoolsOnDelete: true
  gateway:
    type: s3
    port: 80
    instances: 1

---
# 2. 建立 ObjectStore User
apiVersion: ceph.rook.io/v1
kind: CephObjectStoreUser
metadata:
  name: my-user
  namespace: rook-ceph
spec:
  store: my-store
  displayName: "My User"
```

```bash
# 取得 S3 Access Key / Secret Key
kubectl -n rook-ceph get secret rook-ceph-object-user-my-store-my-user \
  -o jsonpath='{.data.AccessKey}' | base64 -d

kubectl -n rook-ceph get secret rook-ceph-object-user-my-store-my-user \
  -o jsonpath='{.data.SecretKey}' | base64 -d

# 用 AWS CLI 存取
aws s3 ls --endpoint-url http://<rgw-service-ip> \
  --aws-access-key-id <access-key> \
  --aws-secret-access-key <secret-key>
```

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：KubeVirt VM 的磁碟應該用 RBD 還是 CephFS？
**答案：RBD（Block Storage）**

原因：
- VM 需要 block device（虛擬磁碟），RBD 直接提供 block device 介面
- VM 磁碟通常是 ReadWriteOnce（單一 VM 獨佔）
- 若需要 Live Migration，使用 ReadWriteMany 的 RBD pool

CephFS 雖然也能給 VM 用，但效能不如 RBD，且 VM 不需要多個節點同時掛載同一個「磁碟」。
:::

::: details 測驗 2：CephFS 的 RWX 是什麼意思？為什麼 RBD 不支援？
**答案：RWX = ReadWriteMany，多個 Node 上的 Pod 同時讀寫**

RBD 是 block device，block device 的掛載是獨佔的（像 USB 隨身碟只能插一台電腦）。多個客戶端同時寫入同一個 block device 會導致資料損毀，所以 RBD 預設只支援 RWO。

CephFS 有自己的檔案鎖定（flock）和 MDS 協調機制，可以安全地讓多個 Client 同時讀寫。
:::

::: details 測驗 3：什麼情況下用 Object Storage（RGW）而不是 Block 或 File？
**答案：**

用 Object Storage 的場景：
1. 資料量極大（PB 級），需要高擴展性
2. 資料用 HTTP REST API 存取（Web 應用、備份工具）
3. 不需要 POSIX 語意（不需要 `ls`、`rename` 等操作）
4. 需要與 AWS S3 相容的工具整合

不適合的情況：
- 需要低延遲隨機讀寫（用 RBD）
- 需要多個程式共用目錄（用 CephFS）
:::

---

## 實作：建立 RBD StorageClass 並掛載到 Pod

```bash
# 前提：已有 Rook Ceph Cluster 跑起來

# 1. 套用 CephBlockPool + StorageClass
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
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: replicapool
  imageFormat: "2"
  imageFeatures: layering
reclaimPolicy: Delete
allowVolumeExpansion: true
EOF

# 2. 建立 PVC
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: test-pvc
spec:
  storageClassName: rook-ceph-block
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
EOF

# 3. 確認 PVC Bound
kubectl get pvc test-pvc
# STATUS 應該是 Bound

# 4. 掛載到 Pod 測試寫入
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: test-pod
spec:
  containers:
    - name: test
      image: busybox
      command: ["/bin/sh", "-c", "echo 'hello ceph' > /data/test.txt && cat /data/test.txt && sleep 3600"]
      volumeMounts:
        - mountPath: /data
          name: data
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: test-pvc
EOF

kubectl logs test-pod
# 應該看到 "hello ceph"
```
