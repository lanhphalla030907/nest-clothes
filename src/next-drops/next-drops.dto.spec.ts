import { validate } from 'class-validator'
import { CreateNextDropDto, UpdateNextDropDto } from './next-drops.dto.js'

const baseDto = (overrides: Record<string, unknown> = {}) => {
  const dto = new CreateNextDropDto()
  dto.title = 'Winter Archive'
  dto.launchAt = '2026-12-01T10:00:00.000Z'
  dto.buttonText = 'Get Access'
  dto.buttonUrl = 'https://shop.example.com/winter-archive'
  dto.isPublished = false
  Object.assign(dto, overrides)
  return dto
}

describe('CreateNextDropDto buttonUrl validation', () => {
  it('accepts an absolute https URL', async () => {
    const dto = baseDto({ buttonUrl: 'https://shop.example.com/winter-archive' })
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('accepts an absolute http URL with port', async () => {
    const dto = baseDto({ buttonUrl: 'http://localhost:5173/collections/summer' })
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('accepts localhost without a TLD', async () => {
    const dto = baseDto({ buttonUrl: 'http://localhost/register' })
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('accepts https with port', async () => {
    const dto = baseDto({ buttonUrl: 'https://shop.example.com:8443/shop' })
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('rejects relative URLs without protocol', async () => {
    const dto = baseDto({ buttonUrl: '/collections/summer' })
    const errors = await validate(dto)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.constraints).toMatchObject({
      isUrl: 'buttonUrl must be a valid URL',
    })
  })

  it('rejects javascript protocol', async () => {
    const dto = baseDto({ buttonUrl: 'javascript:alert(1)' })
    const errors = await validate(dto)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.constraints).toMatchObject({
      isUrl: 'buttonUrl must be a valid URL',
    })
  })

  it('rejects ftp protocol', async () => {
    const dto = baseDto({ buttonUrl: 'ftp://example.com/file' })
    const errors = await validate(dto)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.constraints).toMatchObject({
      isUrl: 'buttonUrl must be a valid URL',
    })
  })

  it('rejects empty string', async () => {
    const dto = baseDto({ buttonUrl: '' })
    const errors = await validate(dto)
    expect(errors.length).toBeGreaterThan(0)
  })
})

describe('UpdateNextDropDto buttonUrl validation', () => {
  const baseUpdate = (overrides: Record<string, unknown> = {}) => {
    const dto = new UpdateNextDropDto()
    Object.assign(dto, overrides)
    return dto
  }

  it('accepts an absolute http localhost URL', async () => {
    const dto = baseUpdate({ buttonUrl: 'http://localhost:5173/collections/summer' })
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('rejects relative URLs', async () => {
    const dto = baseUpdate({ buttonUrl: '/product/abc-123' })
    const errors = await validate(dto)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.constraints).toMatchObject({
      isUrl: 'buttonUrl must be a valid URL',
    })
  })

  it('allows omitting buttonUrl (partial update)', async () => {
    const dto = baseUpdate({})
    const errors = await validate(dto)
    const urlErrors = errors.filter((e) => e.property === 'buttonUrl')
    expect(urlErrors).toHaveLength(0)
  })
})
