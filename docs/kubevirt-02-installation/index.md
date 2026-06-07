# 第二章：安裝與設定

## 前提條件

### 硬體需求

| 項目 | 需求 |
|------|------|
| CPU | 支援 Intel VT-x 或 AMD-V（硬體虛擬化） |
| OS | Linux，已載入 `kvm` 和 `vhost_net` kernel modules |
| Container Runtime | containerd 或 CRI-O |
| k8s 版本 | 最近三個版本（目前 1.28+） |
| API Server 設定 | `--allow-privileged=true` |

### 確認 Node 支援硬體虛擬化

```bash
# 方法一：檢查 CPU flags
egrep -c '(vmx|svm)' /proc/cpuinfo
# 輸出 > 0 表示支援

# 方法二：確認 /dev/kvm 存在
ls -la /dev/kvm

# 方法三：用 virt-host-validate
virt-host-validate qemu
```

---

## 安裝 KubeVirt Operator

KubeVirt 使用 Operator 模式管理自身的部署和升級。

### 步驟 1：取得最新版本號

```bash
export RELEASE=$(curl -s https://storage.googleapis.com/kubevirt-prow/release/kubevirt/kubevirt/stable.txt)
echo "安裝版本：$RELEASE"
```

### 步驟 2：安裝 Operator

```bash
kubectl apply -f https://github.com/kubevirt/kubevirt/releases/download/${RELEASE}/kubevirt-operator.yaml
```

這會在 `kubevirt` namespace 建立：
- CRD（VirtualMachine、VMI 等）
- RBAC 規則
- Operator Deployment

### 步驟 3：建立 KubeVirt CR

```bash
kubectl apply -f https://github.com/kubevirt/kubevirt/releases/download/${RELEASE}/kubevirt-cr.yaml
```

### 步驟 4：等待部署完成

```bash
kubectl -n kubevirt wait kv kubevirt --for condition=Available --timeout=10m
```

### 確認所有元件正常

```bash
kubectl get pods -n kubevirt
# 應該看到：
# virt-api-xxx         Running
# virt-controller-xxx  Running
# virt-handler-xxx     Running（每個 Node 一個）
# virt-operator-xxx    Running
```

---

## KubeVirt CR 設定

`KubeVirt` CR 是整個 KubeVirt 的設定中心：

```yaml
apiVersion: kubevirt.io/v1
kind: KubeVirt
metadata:
  name: kubevirt
  namespace: kubevirt
spec:
  # 軟體模擬（無硬體虛擬化時使用，效能較差）
  configuration:
    developerConfiguration:
      useEmulation: false    # 改為 true 啟用 software emulation

    # Migration 全域設定
    migrations:
      parallelMigrationsPerCluster: 5
      parallelOutboundMigrationsPerNode: 2
      bandwidthPerMigration: "64Mi"

    # 允許使用的 feature gates
    developerConfiguration:
      featureGates:
        - DataVolumes        # 啟用 DataVolume 自動 import
        - LiveMigration      # 啟用 Live Migration
        - HostDisk           # 啟用 hostDisk volume
        - Snapshot           # 啟用 VM Snapshot
        - HotplugVolumes     # 啟用熱插拔 volume
        - GPU                # 啟用 GPU passthrough
        - DownwardMetrics    # 啟用 downward metrics

  # 控制元件放置的 Node
  infra:
    nodePlacement:
      nodeSelector:
        node-role.kubernetes.io/control-plane: ""

  # VM workload 放置的 Node
  workloads:
    nodePlacement:
      nodeSelector:
        kubevirt.io/schedulable: "true"
```

---

## 安裝 virtctl

`virtctl` 是 KubeVirt 的 CLI 工具，提供 VM 特有操作（console、VNC、migrate 等）。

```bash
# 下載 virtctl（macOS ARM）
export RELEASE=$(curl -s https://storage.googleapis.com/kubevirt-prow/release/kubevirt/kubevirt/stable.txt)
curl -Lo virtctl https://github.com/kubevirt/kubevirt/releases/download/${RELEASE}/virtctl-${RELEASE}-darwin-arm64
chmod +x virtctl
sudo mv virtctl /usr/local/bin/

# Linux x86_64
curl -Lo virtctl https://github.com/kubevirt/kubevirt/releases/download/${RELEASE}/virtctl-${RELEASE}-linux-amd64
chmod +x virtctl && sudo mv virtctl /usr/local/bin/

# 或用 krew plugin
kubectl krew install virt
```

---

## 安裝 CDI（Containerized Data Importer）

CDI 是 KubeVirt 的配套工具，負責把 disk image（qcow2、ISO、raw）自動 import 到 PVC，是使用 DataVolume 的前提。

```bash
export CDI_VERSION=$(curl -s https://api.github.com/repos/kubevirt/containerized-data-importer/releases/latest \
  | grep tag_name | cut -d '"' -f 4)

kubectl apply -f https://github.com/kubevirt/containerized-data-importer/releases/download/${CDI_VERSION}/cdi-operator.yaml
kubectl apply -f https://github.com/kubevirt/containerized-data-importer/releases/download/${CDI_VERSION}/cdi-cr.yaml

# 等待完成
kubectl -n cdi wait cdi cdi --for condition=Available --timeout=10m
```

---

## 常用 virtctl 指令

```bash
# VM 基本操作
virtctl start my-vm
virtctl stop my-vm
virtctl restart my-vm
virtctl pause my-vm
virtctl unpause my-vm

# 進入 VM console（串口）
virtctl console my-vm

# VNC 連線
virtctl vnc my-vm

# SSH 到 VM（需要 VM 內有 SSH）
virtctl ssh fedora@my-vm

# 觸發 Live Migration
virtctl migrate my-vm

# 熱插拔 volume
virtctl addvolume my-vm --volume-name=my-pvc
virtctl removevolume my-vm --volume-name=my-pvc

# 查看 VM 資訊
virtctl image-upload pvc my-pvc --image-path=/path/to/image.qcow2 --size=10Gi
```

---

## 驗證安裝：跑第一個 VM

```bash
# 用 containerDisk 快速測試（不需要 PVC）
kubectl apply -f - <<EOF
apiVersion: kubevirt.io/v1
kind: VirtualMachineInstance
metadata:
  name: testvm
spec:
  terminationGracePeriodSeconds: 0
  domain:
    resources:
      requests:
        memory: 64M
    devices:
      disks:
        - name: containerdisk
          disk:
            bus: virtio
        - name: cloudinit
          disk:
            bus: virtio
  volumes:
    - name: containerdisk
      containerDisk:
        image: quay.io/kubevirt/cirros-container-disk-demo
    - name: cloudinit
      cloudInitNoCloud:
        userDataBase64: SGkuXG4=
EOF

# 等待 VM 跑起來
kubectl wait vmi testvm --for condition=Ready --timeout=5m

# 進入 console
virtctl console testvm
```

---

## 常見陷阱

!!! warning "沒有安裝 CDI 就用 DataVolume"
    DataVolume 需要 CDI，若沒有安裝 CDI，建立 DataVolume 的 VM 會卡在 Pending 狀態，且不會有明顯錯誤訊息。

!!! warning "Node 沒有 /dev/kvm"
    若 Node 上沒有 `/dev/kvm`（常見於巢狀虛擬化環境），需要設定 `useEmulation: true`，否則 VM 啟動時會報 `device not found` 錯誤。

!!! info "生產環境建議版本固定"
    不要用 `stable.txt` 動態取版本號安裝，應該固定版本號，確保 Operator 和 CR 版本一致。Operator 升級要先升 Operator，等 `Available` 後再升 CR。
