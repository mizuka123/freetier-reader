variable "name" {
  type = string
}

variable "account_id" {
  type = string
}

variable "zone_id" {
  type = string
}

variable "hostname" {
  type = string
}

variable "tunnel_secret" {
  description = "32 バイト以上の base64 文字列"
  type        = string
  sensitive   = true
}

variable "allowed_emails" {
  type = list(string)
}

variable "session_duration" {
  type = string
}

variable "api_allowed_countries" {
  type = list(string)
}

variable "api_rate_limit_per_10s" {
  type = number
}
