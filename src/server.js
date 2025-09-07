import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { createGzip, createBrotliCompress } from 'node:zlib'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const publicDir = path.join(rootDir, 'public')

// In-memory data model for Returns & Refunds (R-R) program
const db = {
  policies: [
    {
      id: 'default',
      name: 'Standard R-R Policy',
      returnWindowDays: 30,
      refundMethod: 'original_payment',
      requireRmaApproval: true,
      restockingFeePercent: 0,
      conditions: {
        unopenedOnly: false,
        excludeClearance: true
      }
    }
  ],
  reasons: [
    { id: 'damaged', label: 'Arrived damaged' },
    { id: 'defective', label: 'Defective/Not working' },
    { id: 'not_as_described', label: 'Not as described' },
    { id: 'changed_mind', label: 'Changed my mind' }
  ],
  returnRequests: [],
  refunds: []
}

function json(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found')
}

function serveStatic(req, res) {
  let pathname = new URL(req.url, 'http://localhost').pathname
  if (pathname === '/') pathname = '/index.html'
  const filePath = path.normalize(path.join(publicDir, pathname))
  if (!filePath.startsWith(publicDir)) return notFound(res)

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) return notFound(res)

    const ext = path.extname(filePath)
    const type =
      ext === '.html' ? 'text/html; charset=utf-8' :
      ext === '.css' ? 'text/css; charset=utf-8' :
      ext === '.js' ? 'application/javascript; charset=utf-8' :
      ext === '.svg' ? 'image/svg+xml; charset=utf-8' :
      ext === '.json' ? 'application/json; charset=utf-8' :
      'application/octet-stream'

    const isHtml = ext === '.html'
    const cacheControl = isHtml ? 'no-cache' : 'public, max-age=31536000, immutable'

    const etag = `W/"${stats.size}-${stats.mtimeMs.toFixed(0)}"`
    const ifNoneMatch = req.headers['if-none-match']
    const ifModifiedSince = req.headers['if-modified-since']
    const lastModified = new Date(stats.mtimeMs).toUTCString()

    if (ifNoneMatch === etag || (ifModifiedSince && new Date(ifModifiedSince).getTime() >= stats.mtimeMs)) {
      res.writeHead(304, { 'ETag': etag, 'Last-Modified': lastModified, 'Cache-Control': cacheControl })
      return res.end()
    }

    const acceptEncoding = String(req.headers['accept-encoding'] || '')
    const shouldCompress = /^(text|application\/(javascript|json|xml))/.test(type)
    const headers = {
      'Content-Type': type,
      'Cache-Control': cacheControl,
      'ETag': etag,
      'Last-Modified': lastModified,
      'Vary': 'Accept-Encoding'
    }

    const stream = fs.createReadStream(filePath)
    if (shouldCompress && acceptEncoding.includes('br')) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'br' })
      return stream.pipe(createBrotliCompress()).pipe(res)
    }
    if (shouldCompress && acceptEncoding.includes('gzip')) {
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' })
      return stream.pipe(createGzip()).pipe(res)
    }
    res.writeHead(200, headers)
    stream.pipe(res)
  })
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function generateId(prefix) {
  const rnd = Math.random().toString(36).slice(2, 8)
  const ts = Date.now().toString(36)
  return `${prefix}_${ts}_${rnd}`
}

function withinReturnWindow(purchasedAt, windowDays) {
  const purchaseTime = new Date(purchasedAt).getTime()
  const now = Date.now()
  const msInDay = 24 * 60 * 60 * 1000
  return now - purchaseTime <= windowDays * msInDay
}

// Business logic
function evaluateReturnEligibility({ policyId, purchasedAt, isClearance, isOpened }) {
  const policy = db.policies.find(p => p.id === policyId) || db.policies[0]
  const reasons = db.reasons
  const isWithinWindow = withinReturnWindow(purchasedAt, policy.returnWindowDays)
  const failsClearance = policy.conditions.excludeClearance && isClearance
  const failsOpened = policy.conditions.unopenedOnly && isOpened
  const eligible = isWithinWindow && !failsClearance && !failsOpened
  return {
    policy,
    reasons,
    eligible,
    disqualifiers: {
      outsideWindow: !isWithinWindow,
      clearanceExcluded: failsClearance,
      mustBeUnopened: failsOpened
    }
  }
}

function estimateRefundAmount({ pricePaidCents, restockingFeePercent }) {
  const fee = Math.floor((pricePaidCents * (restockingFeePercent || 0)) / 100)
  const amount = Math.max(0, pricePaidCents - fee)
  return { amountCents: amount, feeCents: fee }
}

async function router(req, res) {
  const { method } = req
  const urlObj = new URL(req.url, 'http://localhost')
  const pathname = urlObj.pathname

  if (pathname.startsWith('/api/')) {
    try {
      if (method === 'GET' && pathname === '/api/policies') {
        return json(res, 200, db.policies)
      }
      if (method === 'GET' && pathname === '/api/reasons') {
        return json(res, 200, db.reasons)
      }
      if (method === 'POST' && pathname === '/api/eligibility') {
        const body = await parseBody(req)
        const result = evaluateReturnEligibility({
          policyId: body.policyId || 'default',
          purchasedAt: body.purchasedAt,
          isClearance: !!body.isClearance,
          isOpened: !!body.isOpened
        })
        return json(res, 200, result)
      }
      if (method === 'POST' && pathname === '/api/returns') {
        const body = await parseBody(req)
        const policy = db.policies.find(p => p.id === (body.policyId || 'default')) || db.policies[0]
        const eligibility = evaluateReturnEligibility({
          policyId: policy.id,
          purchasedAt: body.purchasedAt,
          isClearance: !!body.isClearance,
          isOpened: !!body.isOpened
        })
        if (!eligibility.eligible) {
          return json(res, 400, { error: 'Not eligible for return', details: eligibility.disqualifiers })
        }
        const requestId = generateId('ret')
        const request = {
          id: requestId,
          orderId: body.orderId,
          itemId: body.itemId,
          pricePaidCents: body.pricePaidCents,
          reasonId: body.reasonId,
          policyId: policy.id,
          status: policy.requireRmaApproval ? 'pending_approval' : 'approved',
          createdAt: new Date().toISOString()
        }
        db.returnRequests.push(request)

        if (!policy.requireRmaApproval) {
          const { amountCents, feeCents } = estimateRefundAmount({
            pricePaidCents: body.pricePaidCents,
            restockingFeePercent: policy.restockingFeePercent
          })
          const refund = {
            id: generateId('rfnd'),
            returnRequestId: requestId,
            amountCents,
            feeCents,
            method: policy.refundMethod,
            createdAt: new Date().toISOString()
          }
          db.refunds.push(refund)
          request.status = 'refunded'
          return json(res, 201, { request, refund })
        }
        return json(res, 201, { request })
      }
      if (method === 'POST' && pathname.match(/^\/api\/returns\/[^/]+\/approve$/)) {
        const id = pathname.split('/')[3]
        const request = db.returnRequests.find(r => r.id === id)
        if (!request) return json(res, 404, { error: 'Return request not found' })
        if (request.status !== 'pending_approval') return json(res, 400, { error: 'Not pending approval' })
        const policy = db.policies.find(p => p.id === request.policyId) || db.policies[0]
        const { amountCents, feeCents } = estimateRefundAmount({
          pricePaidCents: request.pricePaidCents,
          restockingFeePercent: policy.restockingFeePercent
        })
        const refund = {
          id: generateId('rfnd'),
          returnRequestId: request.id,
          amountCents,
          feeCents,
          method: policy.refundMethod,
          createdAt: new Date().toISOString()
        }
        db.refunds.push(refund)
        request.status = 'refunded'
        return json(res, 200, { request, refund })
      }

      if (method === 'GET' && pathname === '/api/returns') {
        return json(res, 200, db.returnRequests)
      }
      if (method === 'GET' && pathname === '/api/refunds') {
        return json(res, 200, db.refunds)
      }
      return notFound(res)
    } catch (e) {
      return json(res, 400, { error: e.message })
    }
  }

  serveStatic(req, res)
}

const PORT = process.env.PORT || 3000
const server = http.createServer(router)
server.listen(PORT, () => {
  console.log(`R-R program server running at http://localhost:${PORT}`)
})

