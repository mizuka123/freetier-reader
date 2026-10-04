terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

locals {
  # Cloudflare Access の対象外にするパス。末尾の / でパスの境界を明示し、
  # /v1foo や /reader-xxx のような別パスがバイパスされないようにする
  #   /v1/                    Miniflux API
  #   /reader/                Google Reader API
  #   /fever/                 Fever API
  #   /proxy/                 Miniflux 経由の画像（同期 API が返す本文の画像 URL。HMAC 署名付きで、鍵なしでは作れない）
  sync_api_prefixes = ["/v1/", "/reader/", "/fever/", "/proxy/"]
  #   /accounts/ClientLogin   Google Reader API のログイン（完全一致）
  sync_api_exact = ["/accounts/ClientLogin"]
  #   /hook/x/                IFTTT Webhook（URL 内トークンで認証）
  hook_prefix  = "/hook/x/"
  bypass_paths = concat(local.sync_api_prefixes, local.sync_api_exact, [local.hook_prefix])

  # WAF の式も同じパス一覧から作り、Access のバイパス範囲と一致させる
  host_expr = "http.host eq \"${var.hostname}\""
  sync_api_expr = join(" or ", concat(
    [for p in local.sync_api_prefixes : "starts_with(http.request.uri.path, \"${p}\")"],
    [for p in local.sync_api_exact : "http.request.uri.path eq \"${p}\""],
  ))
  bypass_expr = "${local.sync_api_expr} or starts_with(http.request.uri.path, \"${local.hook_prefix}\")"
  country_set = join(" ", [for c in var.api_allowed_countries : "\"${c}\""])

  allowed_idps = var.create_otp_login_method ? [cloudflare_zero_trust_access_identity_provider.otp[0].id] : var.existing_idp_ids

  # PC 向けの Web 画面（ReactFlux）。静的ファイルだけを配信し、API は var.hostname の /v1/ を使う
  web_enabled = var.web_hostname != ""
  web_ingress = local.web_enabled ? [{ hostname = var.web_hostname, path = null, service = "http://reactflux:2000" }] : []
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
    # 上から順に評価される
    ingress = concat(
      [
        {
          hostname = var.hostname
          path     = "^${local.hook_prefix}"
          service  = "http://x-webhook-rss:8080"
        },
        {
          hostname = var.hostname
          path     = null
          service  = "http://miniflux:8080"
        },
      ],
      local.web_ingress,
      [
        {
          hostname = null
          path     = null
          service  = "http_status:404"
        },
      ],
    )
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

resource "cloudflare_dns_record" "web" {
  count   = local.web_enabled ? 1 : 0
  zone_id = var.zone_id
  name    = var.web_hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

# ---- Access ----
# ログイン方式: メールのワンタイムコード（新規の Zero Trust 組織では未設定のことがあるため作成する）
resource "cloudflare_zero_trust_access_identity_provider" "otp" {
  count      = var.create_otp_login_method ? 1 : 0
  account_id = var.account_id
  name       = "One-time PIN"
  type       = "onetimepin"
  config     = {}
}

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
  # 使えるログイン方式を明示する（指定しないとアカウントの全 IdP が使える）
  allowed_idps = local.allowed_idps
  policies     = [{ id = cloudflare_zero_trust_access_policy.allow_owner.id, precedence = 1 }]
}

# Web 画面も UI と同じく本人だけに限定する（API キーはブラウザに保存されるため、画面自体も公開しない）
resource "cloudflare_zero_trust_access_application" "web" {
  count            = local.web_enabled ? 1 : 0
  account_id       = var.account_id
  name             = "${var.name}-web"
  type             = "self_hosted"
  domain           = var.web_hostname
  destinations     = [{ type = "public", uri = var.web_hostname }]
  session_duration = var.session_duration
  allowed_idps     = local.allowed_idps
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

# ---- WAF（Free プランの範囲: レート制限 1 ルール / 期間 10 秒、カスタムルール 5 つ） ----
# 注意: zone 単位のエントリポイント ruleset はフェーズごとに 1 つ。既存ルールがあるゾーンでは import が必要。
resource "cloudflare_ruleset" "api_ratelimit" {
  zone_id = var.zone_id
  name    = "${var.name}-api-ratelimit"
  kind    = "zone"
  phase   = "http_ratelimit"

  # Access をバイパスするパス（同期 API + Webhook）すべてに適用
  rules = [{
    ref         = "freetier_reader_api_ratelimit"
    description = "Rate limit Access-bypassed paths (sync API and webhook)"
    expression  = "(${local.host_expr}) and (${local.bypass_expr})"
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

  # IFTTT（海外のサーバから送信）を止めないよう Webhook は国別制限の対象外
  rules = [{
    ref         = "freetier_reader_api_geo"
    description = "Block sync API outside allowed countries"
    expression  = "(${local.host_expr}) and (${local.sync_api_expr}) and not (ip.src.country in {${local.country_set}})"
    action      = "block"
  }]
}
