import { PrismaClient } from '../generated/prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

// create the pg adapter with our connection string
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
})

// prisma v7 requires an explicit driver adapter - no more built-in rust engine
const prisma = new PrismaClient({ adapter })

export default prisma