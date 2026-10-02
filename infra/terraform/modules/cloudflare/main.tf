terraform {
  required_providers {
    cloudflare = {
      source = "cloudflare/cloudflare"
    }
  }
}

locals {
  # Cloudflare Access の対象外にするパス（ネイティブアプリの同期 API と IFTTT Webhook）
  #   /v1                    Miniflux API
  #   /reader, /accounts     Google Reader API（ログインは /accounts/ClientLogin）
  #   /fever                 Fever API
  #   /hook/x                IFTTT Webhook（URL 内トークンで認証）
  bypass_paths = ["/v1", "/reader", "/accounts/ClientLogin", "/fever", "/hook/x"]

  host_expr = "http.host eq \"${var.hostname}\""
  api_path_expr = join(" or ", [
    "starts_with(http.request.uri.path, \"/v1/\")",
    "starts_with(http.request.uri.path, \"/reader/\")",
    "starts_with(http.request.uri.path, \"/accounts/ClientLogin\")",
    "starts_with(http.request.uri.path, \"/fever\")",
  ])
  country_set = join(" ", [for c in var.api_allowed_countries : "\"${c}\""])
}

# ---- Tunnel ----
resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  account_id    = var.account_id
  name          = var.name
  tunnel_secret = var.tunnel_secret
  config_src    = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id

  config = {
    ingress = [
      {
        hostname = var.hostname
        path     = "^/hook/x/"
        service  = "http://x-webhook-rss:8080"
      },
      {
        hostname = var.hostname
        service  = "http://miniflux:8080"
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "this" {
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

resource "cloudflare_dns_record" "reader" {
  zone_id = var.zone_id
  name    = var.hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

# ---- Access ----
resource "cloudflare_zero_trust_access_policy" "allow_owner" {
  account_id       = var.account_id
  name             = "${var.name}-allow-owner"
  decision         = "allow"
  session_duration = var.session_duration
  include          = [for e in var.allowed_emails : { email = { email = e } }]
}

resource "cloudflare_zero_trust_access_policy" "bypass" {
  account_id       = var.account_id
  name             = "${var.name}-bypass-api"
  decision         = "bypass"
  session_duration = ""
  include          = [{ everyone = {} }]
}

resource "cloudflare_zero_trust_access_application" "ui" {
  account_id       = var.account_id
  name             = var.name
  type             = "self_hosted"
  domain           = var.hostname
  destinations     = [{ type = "public", uri = var.hostname }]
  session_duration = var.session_duration
  policies         = [{ id = cloudflare_zero_trust_access_policy.allow_owner.id, precedence = 1 }]
}

# パスがより具体的なアプリケーションが優先されるため、UI アプリより先に評価される
resource "cloudflare_zero_trust_access_application" "api_bypass" {
  account_id   = var.account_id
  name         = "${var.name}-api-bypass"
  type         = "self_hosted"
  domain       = "${var.hostname}${local.bypass_paths[0]}"
  destinations = [for p in local.bypass_paths : { type = "public", uri = "${var.hostname}${p}" }]
  policies     = [{ id = cloudflare_zero_trust_access_policy.bypass.id, precedence = 1 }]
}

# ---- WAF（Free プランの範囲: レート制限 1 ルール / 期間 10 秒） ----
# 注意: zone 単位のエントリポイント ruleset はフェーズごとに 1 つ。既存ルールがあるゾーンでは import が必要。
resource "cloudflare_ruleset" "api_ratelimit" {
  zone_id = var.zone_id
  name    = "${var.name}-api-ratelimit"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules = [{
    ref         = "freetier_reader_api_ratelimit"
    description = "Rate limit sync API (Access bypassed paths)"
    expression  = "(${local.host_expr}) and (${local.api_path_expr})"
    action      = "block"
    ratelimit = {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 10
      requests_per_period = var.api_rate_limit_per_10s
      mitigation_timeout  = 10
    }
  }]
}

resource "cloudflare_ruleset" "api_geo" {
  zone_id = var.zone_id
  name    = "${var.name}-api-geo"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  # IFTTT（海外のサーバから送信）を止めないよう /hook/x は対象外
  rules = [{
    ref         = "freetier_reader_api_geo"
    description = "Block sync API outside allowed countries"
    expression  = "(${local.host_expr}) and (${local.api_path_expr}) and not (ip.src.country in {${local.country_set}})"
    action      = "block"
  }]
}
