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

### InstanceType vs Preference 比較

| | VirtualMachineInstancetype | VirtualMachinePreference |
|--|---------------------------|--------------------------|
| **用途** | 強制定義資源規格（CPU/Memory） | 預設的設備偏好（可被覆蓋） |
| **VM 能覆蓋？** | ❌ 不能覆蓋 | ✅ VM spec 可以覆蓋 |
| **適合由誰設定** | 管理員（標準化規格） | 管理員（設定 Guest OS 最佳設定） |
| **Cluster-wide 版本** | VirtualMachineClusterInstancetype | VirtualMachineClusterPreference |
| **官方預設套件** | common-instancetypes（u1.micro 到 u1.2xlarge） | common-instancetypes（fedora、windows 等） |

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

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：VM 和 VMI 的差別，以及為什麼要區分這兩個物件？
**答案：**

- **VM**（VirtualMachine）：你的「意圖聲明」，包含 VM 的設定和生命週期策略（runStrategy）。持久存在，不會因為 VM 關機就消失。類比 Deployment。
- **VMI**（VirtualMachineInstance）：實際跑著的 VM，是暫時的。VM 關機 → VMI 刪除。類比 Pod。

**為什麼要區分？**

VM 刪掉 VMI 後，根據 `runStrategy`：
- `Always`：自動重建 VMI（類似 Deployment 自動重建 Pod）
- `RerunOnFailure`：crash 才重建，正常關機不重建
- `Manual`：不自動重建

這讓你可以在不刪 VM 定義的情況下，控制 VM 的生命週期（關機、維護、升級）。
:::

::: details 測驗 2：RunStrategy `Always` 和 `RerunOnFailure` 最大的差別是什麼？
**答案：**

| 情況 | `Always` | `RerunOnFailure` |
|------|---------|-----------------|
| Guest OS 正常 shutdown | 重建 | **不重建** |
| VM crash（QEMU panic） | 重建 | 重建 |
| `virtctl stop` 優雅停止 | 重建 | **不重建** |

`Always` 適合：必須 24/7 跑著的服務（等同 `restartPolicy: Always`）
`RerunOnFailure` 適合：允許手動關機，但崩潰要自動復原（最常用）

踩坑常見點：用 `Always` 的 VM，在 Guest OS 裡執行 `shutdown -h now`，VM 馬上又被重建，以為重啟失敗了。應改用 `virtctl stop`（發 ACPI 信號）後，再根據 runStrategy 決定是否重建。
:::

::: details 測驗 3：Instancetype 和直接在 VM spec 裡設定 CPU/Memory 有什麼差別？
**答案：**

- **直接在 spec 設定**：每次建 VM 都要寫 CPU/Memory，難以標準化
- **Instancetype**：把 CPU/Memory 規格抽成一個可重用的模板，VM 只引用模板名稱

類比：
- `VirtualMachineInstancetype` ≈ AWS EC2 的 instance type（t3.medium、m5.large）
- `VirtualMachinePreference` ≈ 預設的 disk bus、network model（virtio vs e1000）

好處：平台團隊預先定義標準規格（small/medium/large），開發者選規格建 VM，不需要知道底層細節。也方便統一升級規格（改 Instancetype，所有引用的 VM 下次重啟就生效）。
:::

---

## 實作：完整 VM 生命週期操作

```bash
# === 建立 VM（用 RunStrategy: RerunOnFailure）===
kubectl apply -f - <<'EOF'
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: demo-vm
spec:
  runStrategy: RerunOnFailure
  template:
    metadata:
      labels:
        app: demo-vm
    spec:
      domain:
        cpu:
          cores: 2
        memory:
          guest: 1Gi
        devices:
          disks:
            - name: rootdisk
              disk:
                bus: virtio
            - name: emptydisk
              disk:
                bus: virtio
          interfaces:
            - name: default
              masquerade: {}
          rng: {}   # 提供隨機數源（VM 裡跑 systemd 需要）
      networks:
        - name: default
          pod: {}
      volumes:
        - name: rootdisk
          containerDisk:
            image: quay.io/kubevirt/cirros-container-disk-demo
        - name: emptydisk
          emptyDisk:
            capacity: 2Gi   # 臨時空磁碟（不持久化）
EOF

# === 啟動和狀態查詢 ===
virtctl start demo-vm
kubectl get vmi demo-vm -w             # 等待 Running
kubectl describe vmi demo-vm           # 看完整狀態和 Events

# === 進入 VM ===
virtctl console demo-vm                # serial console（Ctrl+] 退出）
virtctl vnc demo-vm                    # 圖形界面（需要 VNC client）

# === Port forward SSH ===
virtctl port-forward demo-vm 2222:22 &
ssh -p 2222 cirros@localhost

# === 暫停 / 恢復 ===
virtctl pause demo-vm
kubectl get vmi demo-vm                # PHASE: Paused
virtctl unpause demo-vm

# === 優雅停機和重啟 ===
virtctl stop demo-vm                   # 發 ACPI 關機信號
virtctl restart demo-vm                # 重啟（stop + start）

# === 查看 VM 底層的 Pod ===
kubectl get pods -l kubevirt.io/vm=demo-vm

# === 刪除 VM（同時刪 VMI）===
kubectl delete vm demo-vm

# === 用 Instancetype 建 VM ===
kubectl apply -f - <<'EOF'
apiVersion: instancetype.kubevirt.io/v1beta1
kind: VirtualMachineInstancetype
metadata:
  name: small
spec:
  cpu:
    guest: 2
  memory:
    guest: 2Gi
---
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: typed-vm
spec:
  runStrategy: Manual
  instancetype:
    name: small
    kind: VirtualMachineInstancetype
  template:
    spec:
      domain:
        devices:
          disks:
            - name: disk
              disk:
                bus: virtio
          interfaces:
            - name: default
              masquerade: {}
      networks:
        - name: default
          pod: {}
      volumes:
        - name: disk
          containerDisk:
            image: quay.io/kubevirt/cirros-container-disk-demo
EOF
kubectl delete vm typed-vm
```
