# 第一章：KubeVirt 架構原理

## 核心設計思路

KubeVirt 的設計哲學只有一句話：**讓 VM 成為 Kubernetes 的一等公民**。

它不重造輪子，不自己做調度、網路、儲存，而是把一切委託給 k8s，自己只做 k8s 原生不支援的部分——讓 QEMU/KVM VM 跑在 Pod 裡。

```
┌──────────────────────────────────────────────────────────────────┐
│               使用者 / kubectl / virtctl / CI                    │
└──────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Kubernetes API Server                          │
│    VirtualMachine、VMI、DataVolume 都是 CRD，走標準 k8s API       │
└──────────────────────────────────────────────────────────────────┘
          │                                       │
          ▼                                       ▼
┌─────────────────┐                   ┌──────────────────────────┐
│   virt-api      │                   │   virt-controller         │
│ （Webhook 驗證） │                   │  （VM 生命週期管理）       │
└─────────────────┘                   └──────────────────────────┘
                                                  │
                                       建立 virt-launcher Pod
                                                  │
                                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Worker Node                              │
│                                                                  │
│  ┌──────────────┐    ┌───────────────────────────────────────┐  │
│  │ virt-handler │    │           virt-launcher Pod            │  │
│  │ (DaemonSet)  │───▶│  libvirtd（私有 instance）             │  │
│  └──────────────┘    │    │                                   │  │
│                      │    ▼                                   │  │
│                      │  QEMU process                          │  │
│                      │    │ KVM（硬體虛擬化）                  │  │
│                      │    ▼                                   │  │
│                      │  Guest OS（Linux / Windows）           │  │
│                      └───────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 核心元件詳解

### virt-api

**角色**：API Server 的延伸，處理 KubeVirt 資源的 Webhook。

```
你 kubectl apply VirtualMachine
        │
        ▼
Kubernetes API Server
        │ 呼叫 Webhook
        ▼
virt-api
  ├── Validating Webhook：驗證 VM spec 格式是否正確
  │     （CPU 設定合法嗎？disk 有指定 volume 嗎？）
  ├── Mutating Webhook：補全預設值
  │     （補預設的 virtio driver、domain 設定）
  └── Subresource API：
        console（VNC/serial console）
        vnc（圖形介面）
        migrate（觸發 Live Migration）
        pause/unpause（暫停 VM）
```

virt-api 是**無狀態**的，可以水平擴展。

### virt-controller

**角色**：類似 kube-controller-manager，管理 VM 的生命週期。

- Watch `VirtualMachine`（VM）和 `VirtualMachineInstance`（VMI）
- 根據 VM 的 `runStrategy`，決定要不要建立 / 刪除 VMI
- 建立 `virt-launcher` Pod（實際跑 VM 的 Pod）
- 管理 VMI 的 Phase 轉換

只有一個 active 實例（leader election），但可以跑多個備份（passive）。

### virt-handler

**角色**：跑在**每個 Node** 的 DaemonSet，是 kubelet 在 KubeVirt 層的類比。

```
virt-handler 負責：
  ├── 監看 Node 上所有 VMI，確保 domain 狀態正確
  ├── 和 virt-launcher 通訊（Unix domain socket）
  │     → 告訴 virt-launcher 要啟動 / 停止 VM
  ├── 同步 VM 的 domain XML 到 libvirt
  ├── 負責 Live Migration 的記憶體傳輸
  └── 回報 VMI 狀態到 API Server
```

### virt-launcher

**角色**：每個 VMI 對應一個 Pod，是 VM 實際跑的地方。

```
1 VMI = 1 virt-launcher Pod = 1 QEMU process

virt-launcher Pod 裡：
  ├── virt-launcher process：主監控程式，監看 QEMU 狀態
  ├── libvirtd process：私有 instance（不是系統共享的）
  └── qemu-system-x86_64 process：實際的 VM
```

**為什麼每個 VM 有自己的 libvirtd？**
傳統 KVM 是一個系統共享 libvirtd 管理多個 VM。KubeVirt 讓每個 VM 有私有 libvirtd，好處是：
- VM 崩潰（QEMU segfault）不影響其他 VM
- 每個 VM 有獨立的資源隔離（cgroup）
- 與 k8s 的 Pod 模型對齊（1 Pod = 1 application）

### libvirt + QEMU/KVM 堆疊

```
virt-launcher
    │ Unix domain socket（/var/run/libvirt/libvirt-sock）
    ▼
libvirtd（虛擬化管理 daemon）
    │ 建立並管理
    ▼
qemu-system-x86_64（or -aarch64）
    │ ioctl() 呼叫
    ▼
/dev/kvm（KVM kernel module）
    │ CPU 硬體虛擬化指令
    ▼
Intel VT-x / AMD-V（VMX/SVM）
```

- **libvirt**：虛擬化管理的業界標準抽象層，統一管理 QEMU、KVM、Xen
- **QEMU**：全功能的硬體模擬器，模擬 CPU、記憶體、PCIe、網卡、磁碟控制器
- **KVM**：Linux kernel module，讓 QEMU 的 Guest vCPU 直接對應 Host CPU，效能接近裸機

---

## VM vs VMI：K8s 類比

| KubeVirt | Kubernetes | 說明 |
|----------|-----------|------|
| `VirtualMachine` (VM) | `Deployment` | 你聲明的「我要一台 VM」，帶生命週期管理 |
| `VirtualMachineInstance` (VMI) | `Pod` | 實際跑著的 VM 實例，是暫時的 |
| `virt-launcher` Pod | 實作細節 | 每個 VMI 對應的 k8s Pod |
| `DataVolume` | `PVC` + import 機制 | 自動從 URL / 映像檔匯入的 PVC |

```bash
kubectl get vm      # 看聲明的 VM（相當於 Deployment）
kubectl get vmi     # 看實際跑著的 VMI（相當於 Pod）

# VM 刪掉 VMI 後：
# - runStrategy: Always → virt-controller 自動重建 VMI
# - runStrategy: Once → 不重建（類似 Job）
```

---

## VM 的啟動完整流程

```
使用者 kubectl apply VirtualMachine（spec.running: true）
        │
        ▼
① API Server 儲存 VM CR 到 etcd
   → virt-api Mutating Webhook 補預設值（domain 設定等）
        │ Watch 事件
        ▼
② virt-controller 偵測到 VM（running=true）
   → 建立 VirtualMachineInstance（VMI）CR
        │
        ▼
③ virt-controller 建立 virt-launcher Pod
   → Pod spec 包含：/dev/kvm 掛載、PVC 掛載、特殊 capabilities
   → Pod 送給 Scheduler
        │
        ▼
④ Scheduler 選 Node（和普通 Pod 完全一樣的調度邏輯）
   → 可以用 nodeSelector、affinity、taint/toleration 控制
        │
        ▼
⑤ kubelet 在選中的 Node 啟動 virt-launcher Pod
   → 掛載 PVC（VM 磁碟）
        │
        ▼
⑥ virt-handler（同 Node 的 DaemonSet）偵測到新 VMI
   → 準備 VM domain XML（把 VMI spec 轉成 libvirt 格式）
   → 透過 Unix socket 通知 virt-launcher
        │
        ▼
⑦ virt-launcher 啟動私有 libvirtd
   → libvirtd 建立 QEMU process（qemu-system-x86_64）
   → QEMU 透過 KVM 啟動 Guest OS
        │
        ▼
⑧ VMI Phase 更新：
   Pending → Scheduling → Scheduled → Running ✅

   virt-handler 持續監控，同步狀態到 API Server
```

---

## RunStrategy：VM 的生命週期策略

VM 的 `runStrategy` 決定 VMI 停止後的行為：

```yaml
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: my-vm
spec:
  runStrategy: RerunOnFailure    # ← 這個欄位
  template:
    ...
```

| runStrategy | 說明 | 類比 |
|------------|------|------|
| `Always` | VMI 停止後永遠重建（含正常關機） | `restartPolicy: Always` |
| `RerunOnFailure` | VMI 非正常退出才重建，正常關機不重建 | `restartPolicy: OnFailure` |
| `Manual` | 不自動管理，要手動用 `virtctl start/stop` | `restartPolicy: Never` |
| `Once` | 只跑一次，停止後不重建 | 類似 Job |
| `Halted` | 保持停止狀態（等同 `spec.running: false`） | - |

```bash
virtctl start my-vm    # 啟動 VM（設定 runStrategy 為 Always / Manual）
virtctl stop my-vm     # 停止 VM（GuestOS ACPI 關機）
virtctl restart my-vm  # 重啟
virtctl pause my-vm    # 暫停（freeze，記憶體保留）
virtctl unpause my-vm  # 繼續
```

---

## KubeVirt 自定義資源（完整 CRD 列表）

| CRD | 說明 |
|-----|------|
| `VirtualMachine` | 有生命週期管理的 VM 聲明 |
| `VirtualMachineInstance` | 實際跑著的 VM 實例 |
| `VirtualMachineInstanceMigration` | 觸發 Live Migration |
| `VirtualMachineInstanceReplicaSet` | 管理多個相同 VMI |
| `VirtualMachineInstancetype` | CPU/Memory 規格模板（可重用） |
| `VirtualMachineClusterInstancetype` | Cluster 範圍的 Instancetype |
| `VirtualMachinePreference` | 設備偏好模板（virtio/bus 設定） |
| `VirtualMachineClusterPreference` | Cluster 範圍的 Preference |
| `DataVolume` | 自動從 URL / container image import PVC |
| `KubeVirt` | KubeVirt Operator 的設定 CR |

---

## The KubeVirt Razor 原則

> 如果一個功能對 Pod 有益，就應該同時對 VM 有益，而不是只為 VM 單獨實作。

這個設計原則確保 KubeVirt 和整個 k8s 生態完全整合：

```
VM 的調度    = k8s Scheduler（affinity / taint / PriorityClass 全支援）
VM 的磁碟    = PVC / CSI（StorageClass、VolumeSnapshot 全支援）
VM 的網路    = CNI / Service / Ingress（masquerade 模式）
VM 的監控    = Prometheus metrics（和 container 同一套 Grafana）
VM 的備份    = VolumeSnapshot（Ceph 快照，kubectl apply 觸發）
VM 的 RBAC   = k8s RBAC（不用另設一套權限系統）
```

---

## 隨堂測驗 {#quiz}

::: details 測驗 1：為什麼每個 VM 有獨立的 libvirtd，而不是共用一個？
**答案：**

傳統 KVM 是一台機器共用一個 libvirtd 管理所有 VM。KubeVirt 改用每 VM 一個私有 libvirtd，原因：

1. **故障隔離**：某個 VM 的 QEMU crash 不會影響同 Node 上其他 VM 的 libvirtd
2. **與 Pod 模型對齊**：1 VM = 1 Pod = 1 進程組，cgroup 隔離才能正確
3. **生命週期綁定**：virt-launcher Pod 終止時，libvirtd 和 QEMU 一起結束，不會有殘留進程
4. **簡化清理**：k8s 直接 kill Pod，OS 自動回收所有子進程，不需要手動清理
:::

::: details 測驗 2：VM 和 VMI 的關係是什麼？刪掉 VMI 後 VM 還在嗎？
**答案：**

- **VM**（VirtualMachine）= 你的「意圖聲明」，等同 Deployment，持久存在
- **VMI**（VirtualMachineInstance）= 實際跑著的 VM 實例，等同 Pod，是暫時的

刪掉 VMI 後：
- **VM 還在**（VM CR 不會消失）
- 是否重建 VMI 取決於 VM 的 `runStrategy`：
  - `Always` → 立刻重建
  - `RerunOnFailure` → 只有非正常終止才重建
  - `Manual` / `Halted` → 不重建，需手動啟動

類比：刪掉 Pod 後，Deployment 還在，k8s 會依據 Deployment 決定是否重建。
:::

::: details 測驗 3：KubeVirt 需要在 Node 上安裝什麼特殊軟體嗎？
**答案：**

需要，但很少：

1. **KVM kernel module** (`kvm.ko`, `kvm-intel.ko` or `kvm-amd.ko`)：Linux 預設已包含
2. **containerd**（或其他 CRI）：k8s 已有
3. **libvirt / QEMU**：**不需要系統層安裝**，它們打包在 `virt-launcher` container image 裡，每個 VM Pod 自帶

這就是 KubeVirt 的優雅之處：Node 只要有 KVM，其他都靠 container image 帶入，不需要污染 Host 環境。

**確認 Node 有 KVM 的方式：**
```bash
egrep -c '(vmx|svm)' /proc/cpuinfo   # 大於 0 = 支援硬體虛擬化
ls /dev/kvm                           # 存在 = KVM module 已載入
```
:::

::: details 測驗 4：virt-controller 和 virt-handler 的分工是什麼？
**答案：**

| | virt-controller | virt-handler |
|--|----------------|--------------|
| 跑的地方 | 任意 Node（Deployment） | 每個 Node（DaemonSet） |
| 角色類比 | kube-controller-manager | kubelet |
| 主要工作 | VM/VMI 生命週期管理（建立 / 刪除 virt-launcher Pod） | 在 Node 上執行 VM 操作（通知 libvirt 啟動 QEMU） |
| 和 libvirt 通訊 | 不直接通訊 | 透過 Unix socket 和 virt-launcher 通訊 |
| 和 API Server | 讀寫 VM/VMI CR | 更新 VMI 的 domain 狀態 |

簡單說：virt-controller 管「哪個 Pod 要存在」，virt-handler 管「這個 Node 上的 VM 要做什麼操作」。
:::

---

## 實作：部署第一個 VM

```bash
# === 確認 KubeVirt 安裝狀態 ===
kubectl -n kubevirt get kubevirt
# PHASE: Deployed

kubectl -n kubevirt get pods
# 應看到 virt-api、virt-controller、virt-handler（每個 Node 一個）

# === 確認 KVM 支援 ===
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.allocatable}{"\n"}{end}' | grep kvm
# 應看到 devices.kubevirt.io/kvm: "number"

# === 建立最簡單的 VM（Fedora，從 container image import）===
kubectl apply -f - <<'EOF'
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: testvm
spec:
  runStrategy: Manual
  template:
    spec:
      domain:
        cpu:
          cores: 1
        memory:
          guest: 1Gi
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
          containerDisk:
            image: quay.io/kubevirt/cirros-container-disk-demo
EOF

# === 啟動 VM ===
virtctl start testvm

# === 等待 VM Running ===
kubectl get vmi testvm -w
# PHASE 從 Pending → Scheduling → Running

# === 進入 VM console（ctrl+] 退出）===
virtctl console testvm

# === 查看 VM 底層的 Pod ===
kubectl get pods | grep virt-launcher

# === 查看 VM 的 Events ===
kubectl describe vmi testvm | grep -A20 Events

# === 停止並刪除 ===
virtctl stop testvm
kubectl delete vm testvm
```
