# 第三章：虛擬機管理

## VM vs VMI：最關鍵的概念區別

| | VirtualMachine (VM) | VirtualMachineInstance (VMI) |
|--|---------------------|------------------------------|
| 類比 | Deployment | Pod |
| 生命週期 | 持久存在，可 start/stop | 跑著就存在，停了就消失 |
| 重啟行為 | 由 RunStrategy 控制自動重建 VMI | 不會自動重建 |
| 直接建立 | 用於長期運行的 VM | 用於臨時測試 |
| 有狀態 | ✅ 保留設定 | ❌ 消失就沒了 |

---

## VirtualMachineInstance（VMI）

VMI 是最底層的 VM 表示，代表一個**正在運行的 VM 實例**。

### 最簡單的 VMI

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstance
metadata:
  name: my-vmi
  namespace: default
spec:
  terminationGracePeriodSeconds: 30    # 優雅關機等待秒數
  domain:
    cpu:
      cores: 2
    resources:
      requests:
        memory: 1Gi
        cpu: "500m"
      limits:
        memory: 2Gi
    devices:
      disks:
        - name: rootdisk
          disk:
            bus: virtio      # virtio 效能最好，其他選項：sata、ide、scsi
        - name: cloudinit
          disk:
            bus: virtio
      interfaces:
        - name: default
          masquerade: {}     # NAT 模式，最常用
  networks:
    - name: default
      pod: {}                # 使用 Pod 網路
  volumes:
    - name: rootdisk
      containerDisk:
        image: quay.io/kubevirt/fedora-cloud-container-disk-demo
    - name: cloudinit
      cloudInitNoCloud:
        userData: |
          #cloud-config
          password: fedora
          chpasswd: { expire: False }
          ssh_authorized_keys:
            - ssh-rsa AAAA...
```

### VMI Phase 轉換

```
Pending → Scheduling → Scheduled → Running → Succeeded / Failed
                                      │
                                      └─ 若 VM 的 runStrategy=Always
                                         virt-controller 自動重建 VMI
```

---

## VirtualMachine（VM）

VM 是 VMI 的上層管理物件，類似 Deployment 管理 Pod。

### RunStrategy：控制 VM 的啟停行為

| RunStrategy | 說明 |
|-------------|------|
| `Always` | VMI 停了就自動重建（類似 Deployment 的 restart policy） |
| `RerunOnFailure` | 只有異常停止時才重建，正常停止（Guest 關機）不重建 |
| `Manual` | 完全手動控制，不自動重建 |
| `Halted` | VM 定義存在但 VMI 不跑 |
| `Once` | 跑一次，完成後不重建 |

### 完整 VM YAML

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: my-vm
  namespace: production
  labels:
    app: my-vm
spec:
  runStrategy: RerunOnFailure    # 推薦：異常重啟，正常關機不重建

  # 綁定 InstanceType（選填）
  instancetype:
    name: u1.medium              # 預定義的資源規格

  # 綁定 Preference（選填）
  preference:
    name: fedora

  template:
    metadata:
      labels:
        kubevirt.io/vm: my-vm
    spec:
      terminationGracePeriodSeconds: 60
      domain:
        cpu:
          cores: 2
          sockets: 1
          threads: 1
          dedicatedCpuPlacement: false   # true = 獨佔 CPU core，適合低延遲
        memory:
          guest: 4Gi
        resources:
          requests:
            memory: 4Gi
        features:
          acpi: {}               # 讓 Guest OS 支援 ACPI 電源管理（正常關機）
          smm:
            enabled: true        # UEFI 需要
        firmware:
          bootloader:
            efi:
              secureBoot: false  # 使用 UEFI 開機
        clock:
          utc: {}
          timer:
            hpet:
              present: false
            pit:
              tickPolicy: delay
            rtc:
              tickPolicy: catchup
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: virtio
              bootOrder: 1
            - name: cloudinit
              disk:
                bus: virtio
          interfaces:
            - name: default
              masquerade: {}
              model: virtio
          rng: {}                # 提供隨機數來源（Guest OS 需要）
      networks:
        - name: default
          pod: {}
      volumes:
        - name: rootdisk
          dataVolume:
            name: my-vm-rootdisk    # 對應下面的 dataVolumeTemplates
        - name: cloudinit
          cloudInitNoCloud:
            userData: |
              #cloud-config
              hostname: my-vm
              user: fedora
              password: changeme
              chpasswd: { expire: False }
              ssh_authorized_keys:
                - ssh-rsa AAAA...

  # DataVolume 模板：VM 建立時自動建立 PVC 並 import disk image
  dataVolumeTemplates:
    - metadata:
        name: my-vm-rootdisk
      spec:
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 20Gi
        storageClassName: standard
        source:
          registry:
            url: docker://quay.io/kubevirt/fedora-cloud-container-disk-demo
```

---

## VM 操作

```bash
# 基本操作
virtctl start my-vm
virtctl stop my-vm         # 發 ACPI 關機信號（優雅關機）
virtctl stop my-vm --force # 強制關機（直接砍掉 VMI）
virtctl restart my-vm

# 暫停 / 恢復（VM 狀態凍結，CPU 停止運行）
virtctl pause my-vm
virtctl unpause my-vm

# 進入 VM
virtctl console my-vm      # 串口 console
virtctl vnc my-vm          # VNC
virtctl ssh user@my-vm     # SSH（需 SSH 服務運行）

# 查看狀態
kubectl get vm my-vm
kubectl get vmi my-vm
kubectl describe vmi my-vm

# 查看 virt-launcher Pod
kubectl get pod -l kubevirt.io/vm=my-vm
kubectl logs -l kubevirt.io=virt-launcher
```

---

## InstanceType 與 Preference

類似 AWS 的 EC2 Instance Type，讓管理員預先定義好資源規格，使用者直接引用，不用每次手寫。

### VirtualMachineInstancetype（強制規格）

```yaml
apiVersion: instancetype.kubevirt.io/v1beta1
kind: VirtualMachineClusterInstancetype   # cluster-wide
metadata:
  name: u1.medium
spec:
  cpu:
    guest: 2              # 2 vCPU，VMI 不能覆蓋
  memory:
    guest: 4Gi            # 4Gi RAM，VMI 不能覆蓋
  ioThreadsPolicy: auto
```

### VirtualMachinePreference（可覆蓋的偏好）

```yaml
apiVersion: instancetype.kubevirt.io/v1beta1
kind: VirtualMachineClusterPreference
metadata:
  name: fedora
spec:
  devices:
    preferredDiskBus: virtio
    preferredInterfaceModel: virtio
    preferredRng: {}
  features:
    preferredAcpi: {}
    preferredSmm:
      enabled: true
  firmware:
    preferredUseEfi: true
    preferredUseSecureBoot: false
  clock:
    preferredClockOffset:
      utc: {}
    preferredTimer:
      hpet:
        present: false
      pit:
        tickPolicy: delay
      rtc:
        tickPolicy: catchup
  cpu:
    preferredCPUTopology: sockets    # vCPU 用 socket 方式呈現
```

### 使用 InstanceType

```yaml
spec:
  instancetype:
    kind: VirtualMachineClusterInstancetype
    name: u1.medium
  preference:
    kind: VirtualMachineClusterPreference
    name: fedora
```

!!! info "common-instancetypes"
    KubeVirt 官方提供一套預定義的 InstanceType：`u1.micro`、`u1.small`、`u1.medium`、`u1.large`、`u1.xlarge`、`u1.2xlarge`。可以直接安裝使用：
    ```bash
    kubectl apply -f https://github.com/kubevirt/common-instancetypes/releases/latest/download/common-instancetypes-all-bundle-k8s.yaml
    ```

---

## Cloud-Init 初始化

Cloud-Init 讓你在 VM 第一次開機時自動執行設定。

```yaml
volumes:
  - name: cloudinit
    cloudInitNoCloud:
      userData: |
        #cloud-config
        hostname: my-server
        users:
          - name: admin
            sudo: ALL=(ALL) NOPASSWD:ALL
            groups: wheel
            ssh_authorized_keys:
              - ssh-rsa AAAA...
        packages:
          - nginx
          - git
        runcmd:
          - systemctl enable --now nginx
          - echo "VM is ready" > /var/log/init.log
        write_files:
          - path: /etc/nginx/conf.d/default.conf
            content: |
              server {
                listen 80;
                location / { return 200 "Hello from KubeVirt VM\n"; }
              }
```

---

## VM Snapshot 與 Restore

需要 CDI + 支援 VolumeSnapshot 的 StorageClass：

```bash
# 建立 Snapshot
kubectl apply -f - <<EOF
apiVersion: snapshot.kubevirt.io/v1beta1
kind: VirtualMachineSnapshot
metadata:
  name: my-vm-snapshot
spec:
  source:
    apiGroup: kubevirt.io
    kind: VirtualMachine
    name: my-vm
EOF

# 查看 Snapshot 狀態
kubectl get vmsnapshot my-vm-snapshot

# 從 Snapshot 還原
kubectl apply -f - <<EOF
apiVersion: snapshot.kubevirt.io/v1beta1
kind: VirtualMachineRestore
metadata:
  name: my-vm-restore
spec:
  target:
    apiGroup: kubevirt.io
    kind: VirtualMachine
    name: my-vm
  virtualMachineSnapshotName: my-vm-snapshot
EOF
```

---

## 常見陷阱

!!! warning "ACPI 沒啟用導致無法優雅關機"
    若 VMI 的 domain spec 沒有 `features.acpi: {}`，`virtctl stop` 會無法發送 ACPI 關機信號，VM 不會正常關機，必須用 `--force` 強制關閉。

!!! warning "RunStrategy 選錯導致 VM 停不掉"
    `RunStrategy: Always` 的 VM，在 Guest OS 內部執行 `shutdown` 後，virt-controller 會馬上重建 VMI。想讓 Guest 自己關機後不重啟，應該用 `RerunOnFailure`。

!!! info "VM 的 IP 是固定的嗎？"
    不是。VMI 背後是一個 Pod，Pod 的 IP 每次重建都會變。如果需要固定存取點，應該建立一個 Service（selector 指向 VMI 的 label），透過 Service IP 存取 VM。
