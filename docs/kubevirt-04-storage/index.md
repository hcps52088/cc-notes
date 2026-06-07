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

## Volume 來源（10 種）

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
