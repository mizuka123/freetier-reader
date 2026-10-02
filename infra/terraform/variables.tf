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
}

variable "tenancy_ocid" {
  description = "テナンシ OCID"
  type        = string
}

variable "compartment_ocid" {
  description = "リソースを作るコンパートメント OCID（null ならテナンシ直下）"
  type        = string
  default     = null
}

variable "availability_domain_index" {
  description = "A1 の在庫がない場合に別の AD を試すためのインデックス"
  type        = number
  default     = 0
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
  description = "ブートボリューム GB（Always Free はブロックストレージ合計 200GB まで）"
  type        = number
  default     = 50
  validation {
    condition     = var.boot_volume_gb >= 50 && var.boot_volume_gb <= 200
    error_message = "50〜200GB で指定してください。"
  }
}

variable "ssh_public_key" {
  description = "VM に登録する SSH 公開鍵（空なら登録しない。接続は OCI Bastion / シリアルコンソール推奨）"
  type        = string
  default     = ""
}

variable "ssh_allowed_cidr" {
  description = "SSH(22) を許可する送信元 CIDR。null なら受信ポートは全閉"
  type        = string
  default     = null
}

variable "budget_alert_email" {
  description = "予算アラートの通知先メール"
  type        = string
}

variable "budget_amount" {
  description = "月次予算（テナンシの通貨単位）。実績がアラート閾値を超えたら通知"
  type        = number
  default     = 1
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
}

variable "cloudflare_zone_id" {
  description = "手持ちドメインのゾーン ID"
  type        = string
}

variable "reader_hostname" {
  description = "公開ホスト名（例: reader.example.com）"
  type        = string
}

variable "allowed_emails" {
  description = "Web UI へのログインを許可するメールアドレス"
  type        = list(string)
}

variable "access_session_duration" {
  description = "Cloudflare Access のセッション時間（730h ≒ 1か月）"
  type        = string
  default     = "730h"
}

variable "api_allowed_countries" {
  description = "アプリ同期 API を許可する国コード（それ以外はブロック。Webhook は対象外）"
  type        = list(string)
  default     = ["JP"]
}

variable "api_rate_limit_per_10s" {
  description = "アプリ同期 API の 10 秒あたりリクエスト上限（同一 IP）"
  type        = number
  default     = 50
}

# ---- アプリ ----
variable "repo_url" {
  description = "VM に clone するリポジトリ（フォークした場合は自分の URL に変更）"
  type        = string
  default     = "https://github.com/mizuka123/freetier-reader.git"
}

variable "repo_ref" {
  description = "clone するブランチ / タグ"
  type        = string
  default     = "main"
}

variable "admin_username" {
  description = "Miniflux 管理者ユーザー名"
  type        = string
  default     = "admin"
}

variable "x_allowed_users" {
  description = "IFTTT から受け付ける X アカウント（@ なし）"
  type        = list(string)
  default     = []
}

variable "ifttt_tz_offset" {
  description = "IFTTT アカウントのタイムゾーン"
  type        = string
  default     = "+09:00"
}

variable "compose_profiles" {
  description = "起動する compose プロファイル"
  type        = list(string)
  default     = ["cloudflare", "x"]
}
