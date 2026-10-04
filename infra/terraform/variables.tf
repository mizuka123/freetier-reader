# ---- OCI ----
variable "oci_config_profile" {
  description = "~/.oci/config のプロファイル名"
  type        = string
  default     = "DEFAULT"
}

variable "oci_region" {
  description = "OCI リージョン（ホームリージョン推奨。Always Free の A1 はホームリージョンのみ）"
  type        = string
  default     = "ap-tokyo-1"
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+-[0-9]+$", var.oci_region))
    error_message = "oci_region は ap-tokyo-1 のような形式で指定してください。"
  }
}

variable "tenancy_ocid" {
  description = "テナンシ OCID"
  type        = string
  validation {
    condition     = startswith(var.tenancy_ocid, "ocid1.tenancy.")
    error_message = "tenancy_ocid は ocid1.tenancy. で始まる値を指定してください。"
  }
}

variable "compartment_ocid" {
  description = "リソースを作るコンパートメント OCID（null ならテナンシ直下）"
  type        = string
  default     = null
  validation {
    condition     = var.compartment_ocid == null || can(regex("^ocid1\\.(compartment|tenancy)\\.", var.compartment_ocid))
    error_message = "compartment_ocid は ocid1.compartment. で始まる値を指定してください。"
  }
}

variable "availability_domain_index" {
  description = "A1 の在庫がない場合に別の AD を試すためのインデックス"
  type        = number
  default     = 0
  validation {
    condition     = var.availability_domain_index >= 0 && var.availability_domain_index <= 2
    error_message = "0〜2 で指定してください。"
  }
}

variable "instance_ocpus" {
  description = "A1 の OCPU 数（Always Free は合計 4 まで）"
  type        = number
  default     = 2
  validation {
    condition     = var.instance_ocpus >= 1 && var.instance_ocpus <= 4
    error_message = "Always Free の範囲（1〜4 OCPU）で指定してください。"
  }
}

variable "instance_memory_gb" {
  description = "A1 のメモリ GB（Always Free は合計 24GB まで）"
  type        = number
  default     = 12
  validation {
    condition     = var.instance_memory_gb >= 1 && var.instance_memory_gb <= 24
    error_message = "Always Free の範囲（1〜24GB）で指定してください。"
  }
}

variable "boot_volume_gb" {
  description = "ブートボリューム GB"
  type        = number
  default     = 50
  validation {
    condition     = var.boot_volume_gb >= 50 && var.boot_volume_gb <= 150
    error_message = "50〜150GB で指定してください。"
  }
}

variable "data_volume_gb" {
  description = "データ用ブロックボリューム GB（Docker のデータ・ローカルバックアップを置く。VM を作り直しても残る）"
  type        = number
  default     = 50
  validation {
    condition     = var.data_volume_gb >= 50 && var.data_volume_gb + var.boot_volume_gb <= 200
    error_message = "50GB 以上、かつブートボリュームとの合計が Always Free の 200GB 以内になるように指定してください。"
  }
}

variable "ssh_public_key" {
  description = "VM に登録する SSH 公開鍵（必須。障害時の復旧に使う。接続は OCI Bastion 経由）"
  type        = string
  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+", var.ssh_public_key))
    error_message = "ssh_public_key に OpenSSH 形式の公開鍵（ssh-ed25519 AAAA... など）を指定してください。"
  }
}

variable "bastion_client_cidrs" {
  description = "OCI Bastion のセッション作成を許可する接続元 CIDR（SSH 鍵認証は別途必要）"
  type        = list(string)
  default     = ["0.0.0.0/0"]
  validation {
    condition     = length(var.bastion_client_cidrs) > 0 && alltrue([for c in var.bastion_client_cidrs : can(cidrhost(c, 0))])
    error_message = "CIDR 形式（例: 203.0.113.10/32）で 1 つ以上指定してください。"
  }
}

variable "budget_alert_email" {
  description = "予算アラートの通知先メール"
  type        = string
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_alert_email))
    error_message = "メールアドレスを指定してください。"
  }
}

variable "budget_amount" {
  description = "月次予算（テナンシの通貨単位）。実績がその 1% を超えたら通知"
  type        = number
  default     = 1
  validation {
    condition     = var.budget_amount > 0
    error_message = "0 より大きい値を指定してください。"
  }
}

variable "backup_retention_days" {
  description = "Object Storage 上のバックアップ保持日数"
  type        = number
  default     = 30
  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 365
    error_message = "7〜365 日で指定してください。"
  }
}

# ---- Cloudflare ----
variable "cloudflare_api_token" {
  description = "Cloudflare API トークン（docs/terraform.md の権限で作成）"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare アカウント ID"
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "32 桁の 16 進数で指定してください。"
  }
}

variable "cloudflare_zone_id" {
  description = "手持ちドメインのゾーン ID"
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "32 桁の 16 進数で指定してください。"
  }
}

variable "reader_hostname" {
  description = "公開ホスト名（例: reader.example.com。スキームやパスは含めない）"
  type        = string
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.reader_hostname))
    error_message = "reader.example.com のような小文字のホスト名を指定してください（https:// や / は不要）。"
  }
}

variable "allowed_emails" {
  description = "Web UI へのログインを許可するメールアドレス"
  type        = list(string)
  validation {
    condition     = length(var.allowed_emails) > 0 && alltrue([for e in var.allowed_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "メールアドレスを 1 つ以上指定してください。"
  }
}

variable "create_otp_login_method" {
  description = "Cloudflare Access のログイン方式「One-time PIN」を作成する（既にアカウントにある場合は false にして existing_access_idp_ids を指定）"
  type        = bool
  default     = true
}

variable "existing_access_idp_ids" {
  description = "create_otp_login_method = false のときに Web UI で許可する既存のログイン方式（IdP）の ID"
  type        = list(string)
  default     = []
  validation {
    condition     = var.create_otp_login_method || length(var.existing_access_idp_ids) > 0
    error_message = "create_otp_login_method = false の場合は existing_access_idp_ids に既存のログイン方式の ID を指定してください（Zero Trust → Settings → Authentication）。"
  }
}

variable "access_session_duration" {
  description = "Cloudflare Access のセッション時間（730h ≒ 1か月）"
  type        = string
  default     = "730h"
  validation {
    condition     = can(regex("^[0-9]+(h|m)$", var.access_session_duration))
    error_message = "730h のように時間（h）または分（m）で指定してください。"
  }
}

variable "api_allowed_countries" {
  description = "アプリ同期 API を許可する国コード（ISO 3166-1 alpha-2、大文字）。Webhook は対象外"
  type        = list(string)
  default     = ["JP"]
  validation {
    condition     = length(var.api_allowed_countries) > 0 && alltrue([for c in var.api_allowed_countries : can(regex("^[A-Z]{2}$", c))])
    error_message = "JP のような大文字 2 文字の国コードを 1 つ以上指定してください。"
  }
}

variable "api_rate_limit_per_10s" {
  description = "同期 API と Webhook の 10 秒あたりリクエスト上限（同一 IP）。初回同期で超える場合は引き上げる（docs/apps.md）"
  type        = number
  default     = 150
  validation {
    condition     = var.api_rate_limit_per_10s >= 1
    error_message = "1 以上を指定してください。"
  }
}

# ---- アプリ ----
variable "repo_url" {
  description = "VM に clone するリポジトリ（フォークした場合は自分の URL に変更）"
  type        = string
  default     = "https://github.com/mizuka123/freetier-reader.git"
  validation {
    condition     = can(regex("^https://[A-Za-z0-9._/-]+\\.git$", var.repo_url))
    error_message = "https://github.com/<you>/freetier-reader.git の形式で指定してください。"
  }
}

variable "repo_ref" {
  description = "clone するブランチ / タグ"
  type        = string
  default     = "main"
  validation {
    condition     = can(regex("^[A-Za-z0-9._/-]+$", var.repo_ref))
    error_message = "ブランチ名またはタグ名を指定してください。"
  }
}

variable "auto_update" {
  description = "週 1 回、リポジトリとコンテナを自動更新する（失敗時は自動ロールバック）"
  type        = bool
  default     = false
}

variable "admin_username" {
  description = "Miniflux 管理者ユーザー名"
  type        = string
  default     = "admin"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]{3,32}$", var.admin_username))
    error_message = "英数字と _ . - の 3〜32 文字で指定してください。"
  }
}

variable "miniflux_theme" {
  description = "画面テーマ（dads: デジタル庁デザインシステムを参考にした非公式テーマ / none: 適用しない）"
  type        = string
  default     = "dads"
  validation {
    condition     = contains(["dads", "none"], var.miniflux_theme)
    error_message = "dads または none を指定してください。"
  }
}

variable "theme_web_font" {
  description = "Noto Sans JP を Google Fonts から読み込む（閲覧端末から Google へ通信が発生する）"
  type        = bool
  default     = false
}

variable "x_allowed_users" {
  description = "IFTTT から受け付ける X アカウント（@ なし）"
  type        = list(string)
  default     = []
  validation {
    condition     = alltrue([for u in var.x_allowed_users : can(regex("^[A-Za-z0-9_]{1,15}$", u))])
    error_message = "X のユーザー名（英数字と _、15 文字以内、@ なし）で指定してください。"
  }
}

variable "x_stale_hours" {
  description = "この時間 IFTTT から受信がなければ監視で異常とする（0 で無効）"
  type        = number
  default     = 72
  validation {
    condition     = var.x_stale_hours == floor(var.x_stale_hours) && var.x_stale_hours >= 0 && var.x_stale_hours <= 8760
    error_message = "0〜8760 の整数で指定してください（0 で無効）。"
  }
}

variable "x_webhook_rss_image" {
  description = "x-webhook-rss のビルド済みイメージ（空なら VM 上でローカルビルド）"
  type        = string
  default     = ""
  validation {
    condition     = var.x_webhook_rss_image == "" || can(regex("^[a-z0-9.-]+(:[0-9]+)?(/[a-z0-9._-]+)+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$", var.x_webhook_rss_image))
    error_message = "registry/name[:tag]@sha256:<digest> の形式で指定してください。"
  }
}

variable "ifttt_tz_offset" {
  description = "IFTTT アカウントのタイムゾーン"
  type        = string
  default     = "+09:00"
  validation {
    condition     = can(regex("^[+-](0[0-9]|1[0-4]):[0-5][0-9]$", var.ifttt_tz_offset))
    error_message = "+09:00 の形式で指定してください。"
  }
}

variable "compose_profiles" {
  description = "起動する compose プロファイル"
  type        = list(string)
  default     = ["cloudflare", "x"]
  validation {
    condition     = alltrue([for p in var.compose_profiles : contains(["cloudflare", "x", "morss", "rsshub", "web"], p)])
    error_message = "cloudflare / x / morss / rsshub / web から選んでください。"
  }
}

variable "web_hostname" {
  description = "PC 向けの Web 画面（ReactFlux）を公開するホスト名（例: web.example.com）。空なら公開しない。設定する場合は compose_profiles に web を含める（docs/web.md）"
  type        = string
  default     = ""
  validation {
    condition     = var.web_hostname == "" || can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.web_hostname))
    error_message = "web.example.com のような小文字のホスト名を指定してください（https:// や / は不要）。"
  }
  validation {
    condition     = var.web_hostname == "" || (contains(var.compose_profiles, "web") && var.web_hostname != var.reader_hostname)
    error_message = "web_hostname を設定する場合は compose_profiles に web を含め、reader_hostname とは別のホスト名にしてください。"
  }
}

variable "healthcheck_ping_url" {
  description = "死活監視の ping URL（Healthchecks.io 等。scripts/monitor.sh が 10 分ごとに通知）"
  type        = string
  default     = ""
  validation {
    condition     = var.healthcheck_ping_url == "" || can(regex("^https://[A-Za-z0-9._~:/?#@!&+,;=%-]+$", var.healthcheck_ping_url))
    error_message = "https:// で始まる URL を指定してください（空白・引用符・$ などは使えません）。"
  }
}

variable "backup_ping_url" {
  description = "バックアップ成功/失敗の ping URL（Healthchecks.io 等）"
  type        = string
  default     = ""
  validation {
    condition     = var.backup_ping_url == "" || can(regex("^https://[A-Za-z0-9._~:/?#@!&+,;=%-]+$", var.backup_ping_url))
    error_message = "https:// で始まる URL を指定してください（空白・引用符・$ などは使えません）。"
  }
}
