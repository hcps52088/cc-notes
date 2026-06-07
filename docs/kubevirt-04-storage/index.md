# 第四章：Storage

## 整體架構

```
VirtualMachine
    │ 引用 volume
    ▼
┌───────────────────────────────────────────────────┐
│  Volume 來源（10 種）                               │
│  containerDisk / PVC / DataVolume / cloudInit...  │
└───────────────────────────────────────────────────┘
    │ 掛載成
    ▼
┌───────────────────────────────────────────────────┐
│  Disk 呈現方式（4 種）                              │
│  disk / cdrom / lun / filesystem(virtiofs)        │
└───────────────────────────────────────────────────┘
    │
    ▼
QEMU / KVM（VM 看到的是虛擬磁碟）
```

---

## Disk 類型（呈現給 VM 的方式）

### disk（最常用）

標準虛擬磁碟，VM 看到的是一個 block device：

```yaml
devices:
  disks:
    - name: rootdisk
      disk:
        bus: virtio      # virtio（效能最好）/ sata / ide / scsi
```

**Bus 選擇：**

| Bus | 效能 | 相容性 | 適用場景 |
|-----|------|--------|----------|
| `virtio` | ⭐⭐⭐ | 需要驅動（Linux 內建，Windows 需安裝） | Linux VM 首選 |
| `sata` | ⭐⭐ | 廣泛相容 | Windows VM |
| `scsi` | ⭐⭐ | 廣泛相容 | 需要 SCSI 特性 |
| `ide` | ⭐ | 最廣泛 | 舊系統相容 |

### cdrom（唯讀光碟）

掛載 ISO 或唯讀 image：

```yaml
devices:
  disks:
    - name: iso
      cdrom:
        bus: sata
        readonly: true
        tray: closed
```

### lun（SCSI LUN 直通）

直接將 Block Device 以 SCSI LUN 方式給 VM，用於特殊 SCSI 指令需求（如 cluster software）：

```yaml
devices:
  disks:
    - name: shared-storage
      lun:
        bus: scsi
        reservation: true    # 開啟 SCSI reservation（共用儲存需要）
```

### filesystem / virtiofs（目錄共享）

把 Host 的目錄直接共享進 VM，VM 以 filesystem 方式掛載：

```yaml
devices:
  filesystems:
    - name: shared-data
      virtiofs: {}

volumes:
  - name: shared-data
    persistentVolumeClaim:
      claimName: my-pvc
```

VM 內掛載：
```bash
mount -t virtiofs shared-data /mnt/data
```

---

## Volume 來源（12 種）

### 常見 Volume 來源比較

| Volume 來源 | 資料持久性 | 需要 CDI | 典型用途 |
|------------|---------|---------|---------|
| `containerDisk` | ❌（VMI 刪掉就沒了） | ❌ | 快速測試、無狀態 VM |
| `persistentVolumeClaim` | ✅ | ❌ | 生產 VM 磁碟（事先準備好 PVC） |
| `dataVolume` | ✅ | ✅ | 生產 VM 磁碟（自動 import OS image） |
| `ephemeral` | ❌（停機就消失） | ❌ | COW 暫時磁碟，以 PVC 為 backing |
| `cloudInitNoCloud` | 僅初始化用 | ❌ | cloud-init 設定（密碼、SSH key）|
| `cloudInitConfigDrive` | 僅初始化用 | ❌ | OpenStack 格式 cloud-init |
| `hostDisk` | ✅（存在 Node hostPath） | ❌ | 測試、單節點場景（無法 Migration） |
| `configMap` | 依 ConfigMap | ❌ | 注入設定檔到 VM |
| `secret` | 依 Secret | ❌ | 注入憑證、金鑰 |
| `serviceAccount` | 依 SA token | ❌ | VM 存取 k8s API |
| `emptyDisk` | ❌（VMI 刪掉就沒了） | ❌ | 臨時暫存空間（sparse qcow2） |
| `downwardMetrics` | N/A | ❌ | 暴露 VM 和 Host 的 metrics 給 Guest OS |

### 1. containerDisk（最適合測試）

把 disk image 打包進 container image，從 registry 拉取：

```yaml
volumes:
  - name: rootdisk
    containerDisk:
      image: quay.io/kubevirt/fedora-cloud-container-disk-demo:latest
      imagePullPolicy: IfNotPresent
```

!!! warning "containerDisk 是暫時性的"
    containerDisk 存在 Node 本地，VMI 重建後資料全部消失。只適合無狀態 VM 或測試用途。

### 2. persistentVolumeClaim（PVC）

生產環境最常用，資料永久保留：

```yaml
volumes:
  - name: rootdisk
    persistentVolumeClaim:
      claimName: my-vm-disk
      readOnly: false
```

PVC 要求：
- 存取模式 `ReadWriteOnce`（單節點）或 `ReadWriteMany`（Live Migration 需要）
- 可以是 filesystem 或 block mode（block 效能更好）

```yaml
# Block mode PVC 效能更佳
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-vm-disk
spec:
  accessModes:
    - ReadWriteMany          # Live Migration 需要 RWX
  volumeMode: Block          # 使用 block mode
  resources:
    requests:
      storage: 20Gi
  storageClassName: ceph-rbd
```

### 3. dataVolume（推薦：自動 import）

#### DataVolume 來源比較

| 來源 | 設定欄位 | 說明 | 需要 CDI |
|------|---------|------|---------|
| HTTP URL | `source.http.url` | 從公開 URL 下載 qcow2/raw | ✅ |
| Container Registry | `source.registry.url` | 從 OCI image 取出 disk | ✅ |
| 現有 PVC 複製 | `source.pvc` | Clone 現有 PVC 的資料 | ✅ |
| 空白磁碟 | `source.blank` | 建立空的 PVC | ✅ |
| 上傳 | `source.upload` | 用 `virtctl image-upload` 上傳 | ✅ |
| S3 | `source.s3` | 從 S3 bucket 下載 | ✅ |
| GCS | `source.gcs` | 從 Google Cloud Storage 下載 | ✅ |

DataVolume 是 CDI 提供的功能，自動幫你建立 PVC 並從外部來源 import disk image：

```yaml
# 在 VM 的 dataVolumeTemplates 裡定義
dataVolumeTemplates:
  - metadata:
      name: my-vm-rootdisk
    spec:
      storage:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 20Gi
        storageClassName: standard
      source:
        # 從 HTTP URL import
        http:
          url: https://cloud.centos.org/centos/9-stream/x86_64/images/CentOS-Stream-9-latest.x86_64.qcow2

        # 或從 container registry import
        # registry:
        #   url: docker://quay.io/containerdisks/centos-stream:9

        # 或複製現有 PVC
        # pvc:
        #   namespace: default
        #   name: source-pvc

        # 或空白磁碟
        # blank: {}
```

DataVolume import 狀態追蹤：
```bash
kubectl get datavolume my-vm-rootdisk
# PHASE 欄位：ImportScheduled → ImportInProgress → Succeeded
kubectl describe datavolume my-vm-rootdisk
```

### 4. cloudInitNoCloud / cloudInitConfigDrive

Cloud-Init 資料，VM 第一次開機讀取並執行：

```yaml
volumes:
  - name: cloudinit
    cloudInitNoCloud:
      userData: |
        #cloud-config
        password: mypassword
        chpasswd: { expire: False }
      networkData: |
        version: 2
        ethernets:
          eth0:
            dhcp4: true
```

### 5. ephemeral（Copy-on-Write 暫時磁碟）

以現有 PVC 為 backing store，所有寫入存在本地，VMI 刪除後寫入的資料消失：

```yaml
volumes:
  - name: rootdisk
    ephemeral:
      persistentVolumeClaim:
        claimName: golden-image-pvc   # 唯讀基底 image
```

!!! tip "Golden Image 模式"
    用 ephemeral 可以讓多個 VMI 共用同一個 base image PVC，又各自有獨立的寫入空間，很適合做 VM template。

### 6. emptyDisk（臨時空白磁碟）

動態建立的空白暫時磁碟，用來給 VM 額外的臨時空間：

```yaml
volumes:
  - name: temp-disk
    emptyDisk:
      capacity: 10Gi
```

### 7. hostDisk（Node 本地路徑）

使用 Node 上的本地檔案作為 VM 磁碟：

```yaml
volumes:
  - name: local-disk
    hostDisk:
      path: /data/vms/my-vm.img
      type: DiskOrCreate    # 不存在就建立；或 Disk（必須存在）
      capacity: 20Gi
```

!!! warning "hostDisk 綁定 Node"
    使用 hostDisk 的 VMI 必須調度到有該路徑的 Node，建議搭配 nodeSelector / affinity 確保正確調度。無法做 Live Migration。

### 8. configMap / secret / serviceAccount

把 k8s 資源掛進 VM：

```yaml
volumes:
  - name: config
    configMap:
      name: my-config
  - name: secrets
    secret:
      secretName: my-secret
  - name: sa-token
    serviceAccount:
      serviceAccountName: my-sa
```

VM 看到的是一個虛擬 CD-ROM，內容是資源的 key/value 對應成檔案。

---

## DataVolume 進階：Preallocation 與效能

```yaml
spec:
  preallocation: true    # 預先分配空間，避免稀疏磁碟效能問題

  # 設定 import 來源驗證
  source:
    http:
      url: https://example.com/image.qcow2
      certConfigMap: my-cert-configmap    # 自訂 CA
      extraHeaders:
        - "Authorization: Bearer mytoken"
```

---

## 熱插拔 Volume（Hotplug）

需要開啟 `HotplugVolumes` feature gate：

```bash
# 新增 volume 到執行中的 VM
virtctl addvolume my-vm \
  --volume-name=extra-disk \
  --persist    # 永久加入 VM spec（不加則重啟後消失）

# 移除 volume
virtctl removevolume my-vm --volume-name=extra-disk
```

---

## 常見陷阱

!!! warning "PVC 的 accessMode 影響 Live Migration"
    Live Migration 需要 VMI 在兩個 Node 上同時能存取同一個 PVC，所以 PVC 必須是 `ReadWriteMany`。若用 `ReadWriteOnce`，Migration 會失敗。

!!! warning "DataVolume import 很慢"
    import 大型 qcow2 image（幾十 GB）可能要幾十分鐘，這段時間 VM 無法啟動。建議先 import 到 PVC 做成 golden image，再用 PVC clone 快速複製。

!!! info "disk image 格式支援"
    KubeVirt / CDI 支援 qcow2、raw、vmdk、vhd / vhdx、iso 等格式，import 時 CDI 會自動轉換成 raw 或 qcow2。

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：containerDisk 和 DataVolume 最大的差別是什麼？什麼時候用哪個？
**答案：**

| | containerDisk | DataVolume |
|--|-------------|-----------|
| 持久化 | **否**（Pod 重啟資料消失） | **是**（資料存在 Ceph/PVC） |
| 啟動速度 | 快（直接掛 container image） | 慢（需要 import） |
| 適用場景 | 開發測試、唯讀 rootfs | 生產環境 VM |
| 需要 CDI | 否 | **是** |

**選擇原則：**
- 測試 KubeVirt 功能 → containerDisk（快速、不留資料）
- 生產 VM → DataVolume（持久化、有備份可能性）
- Stateless 服務跑在 VM 上 → containerDisk（每次 fresh state）
:::

::: details 測驗 2：DataVolume 的 import 流程是什麼？為什麼 VM 要等 DataVolume Succeeded 才能啟動？
**答案：**

import 流程：
1. CDI 看到 DataVolume CR
2. 建立一個 PVC（空的）
3. 建立一個 importer Pod，從 source（URL / registry / PVC）下載並轉換 image
4. importer Pod 把 image 寫入 PVC
5. DataVolume 狀態變 `Succeeded`，刪除 importer Pod
6. VM 可以啟動，PVC 已有完整的 OS image

**為什麼要等 Succeeded？**

VM 的 QEMU 直接把 PVC 當 block device 啟動。如果 import 沒完成（PVC 只有部分資料），VM 啟動後會讀到損壞的 disk，輕則報錯，重則 Guest OS panic。

KubeVirt 會把有 `WaitForFirstConsumer` DataVolume 的 VM 保持在 `WaitingForVolumeBinding` 狀態，等 DataVolume Succeeded 才建立 virt-launcher Pod。
:::

::: details 測驗 3：為什麼 KubeVirt VM 的 PVC 要用 `volumeMode: Block` 而不是 `Filesystem`？
**答案：**

- **Filesystem mode**：k8s CSI 把 PVC 格式化成 ext4/xfs 後 mount 進 Pod，Pod 看到的是目錄
- **Block mode**：直接把 raw block device 暴露給 Pod，Pod 看到的是 `/dev/xxx`

QEMU 需要 raw block device 來模擬虛擬磁碟，原因：
1. QEMU 要自己管理磁碟格式（qcow2 / raw）和 partition table
2. 如果 CSI 先格式化成 ext4，QEMU 還要在 ext4 裡面建一個虛擬磁碟檔案，中間多了一層，效能差
3. Block mode 讓 QEMU 直接操作 block device，等同於實體機插了一塊硬碟進去

**重要**：`volumeMode: Block` 的 PVC 必須在 VM spec 裡用 `disk.bus: virtio`（或其他 bus），不能像普通 Pod 那樣直接 mount 目錄。
:::

---

## 實作：VM 存儲操作

```bash
# === 確認 CDI 安裝 ===
kubectl -n cdi get pods
# cdi-operator、cdi-apiserver、cdi-controller、cdi-uploadproxy

# === 建立有 DataVolume 的 VM（從 Fedora container image import）===
kubectl apply -f - <<'EOF'
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: fedora-vm
spec:
  runStrategy: RerunOnFailure
  dataVolumeTemplates:
    - metadata:
        name: fedora-vm-disk
      spec:
        storage:
          storageClassName: rook-ceph-block
          accessModes: [ReadWriteOnce]
          volumeMode: Block
          resources:
            requests:
              storage: 10Gi
        source:
          registry:
            url: docker://quay.io/containerdisks/fedora:40
  template:
    spec:
      domain:
        cpu:
          cores: 2
        memory:
          guest: 2Gi
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: virtio
          interfaces:
            - name: default
              masquerade: {}
      networks:
        - name: default
          pod: {}
      volumes:
        - name: rootdisk
          dataVolume:
            name: fedora-vm-disk
EOF

# === 監控 DataVolume import 進度 ===
kubectl get datavolume fedora-vm-disk -w
# PHASE: ImportScheduled → ImportInProgress → Succeeded

# === 確認 PVC 建立 ===
kubectl get pvc fedora-vm-disk
# STORAGECLASS: rook-ceph-block, VOLUME MODE: Block

# === 確認 import Pod ===
kubectl get pods | grep importer
# CDI 的 importer pod，import 完成後自動消失

# === 等 VM 跑起來後 snapshot ===
kubectl apply -f - <<'EOF'
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: fedora-vm-snapshot
spec:
  volumeSnapshotClassName: csi-rbdplugin-snapclass
  source:
    persistentVolumeClaimName: fedora-vm-disk
EOF

kubectl get volumesnapshot fedora-vm-snapshot
# READYTOUSE: true

# === 從 snapshot clone 一個新 VM ===
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: fedora-vm-clone
spec:
  storageClassName: rook-ceph-block
  dataSource:
    name: fedora-vm-snapshot
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes: [ReadWriteOnce]
  volumeMode: Block
  resources:
    requests:
      storage: 10Gi
EOF
# 新 PVC 可以直接給另一個 VM 使用（Golden Image 模式）

# === 清理 ===
kubectl delete vm fedora-vm
kubectl delete pvc fedora-vm-disk fedora-vm-clone
kubectl delete volumesnapshot fedora-vm-snapshot
```
