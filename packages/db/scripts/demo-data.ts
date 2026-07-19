/**
 * Demo data, for looking at the admin panel with something in it.
 *
 * Development only. Every screen in the panel reads real endpoints, so an empty
 * database renders empty tables — correct, but indistinguishable from broken.
 * This creates a small, plausible slice: staff across the three outlets, a
 * question bank covering all three §10.1 types, a sat exam, and one attempt
 * left waiting for a human so the grading screen has work in it.
 *
 *   npm run db:demo         # create
 *   npm run db:demo -- --clear   # remove everything it created
 *
 * Everything it writes is tagged so --clear can find it again: users get the
 * 98xx phone range, questions get the 'demo' tag, exams the DEMO- code prefix.
 * Nothing outside those markers is touched, so the reference data and any real
 * accounts survive both operations.
 */
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '@bookends/core'

const prisma = new PrismaClient()

const DEMO_PASSWORD = 'BookendsDev1'
const DEMO_TAG = 'demo'
const DEMO_EXAM_PREFIX = 'DEMO-'
/** Demo staff live here; real staff are seeded from 9000000000 upward by tests. */
const PHONE_BASE = 9800000000

/** Codes come from packages/db/src/seed-data.ts — Service is SRV, not SVC. */
const STAFF = [
  { first: 'Priya', last: 'Shah', outlet: 'AK', dept: 'KIT', desig: 'CDP' },
  { first: 'Rahul', last: 'Mehta', outlet: 'AK', dept: 'SRV', desig: 'STWD' },
  { first: 'Anjali', last: 'Desai', outlet: 'CP', dept: 'KIT', desig: 'LCOOK' },
  { first: 'Vikram', last: 'Patel', outlet: 'CP', dept: 'SRV', desig: 'CAPT' },
  { first: 'Meera', last: 'Joshi', outlet: 'PR', dept: 'KIT', desig: 'LCOOK' },
]

const MCQ_OPTIONS = [
  { id: 'a', textEn: 'Below 4°C', textHi: '4°C से नीचे', isCorrect: true },
  { id: 'b', textEn: 'Below 10°C', textHi: '10°C से नीचे', isCorrect: false },
  { id: 'c', textEn: 'Below 15°C', textHi: '15°C से नीचे', isCorrect: false },
  { id: 'd', textEn: 'Room temperature', textHi: 'कमरे का तापमान', isCorrect: false },
]

const RUBRIC = [
  { criterion: 'Plating symmetry', maxMarks: 4, description: 'Even, deliberate arrangement' },
  { criterion: 'Portion accuracy', maxMarks: 3, description: 'Matches the spec sheet' },
  { criterion: 'Garnish and finish', maxMarks: 3, description: 'Fresh, clean, intentional' },
]

async function clear() {
  console.log('Removing demo data…')

  const users = await prisma.user.findMany({
    where: { phone: { startsWith: '98' } },
    select: { id: true },
  })
  const userIds = users.map((u) => u.id)

  const employees = await prisma.employee.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  })
  const employeeIds = employees.map((e) => e.id)

  const exams = await prisma.exam.findMany({
    where: { examCode: { startsWith: DEMO_EXAM_PREFIX } },
    select: { id: true },
  })
  const examIds = exams.map((e) => e.id)

  // Leaf-first, mirroring the FK graph: responses and sessions hang off
  // assignments, assignments off exams and employees.
  await prisma.examResponse.deleteMany({
    where: { OR: [{ examAssignment: { examId: { in: examIds } } }, { examAssignment: { employeeId: { in: employeeIds } } }] },
  })
  await prisma.examSession.deleteMany({
    where: { examAssignment: { OR: [{ examId: { in: examIds } }, { employeeId: { in: employeeIds } }] } },
  })
  await prisma.examAssignment.deleteMany({
    where: { OR: [{ examId: { in: examIds } }, { employeeId: { in: employeeIds } }] },
  })
  await prisma.examQuestion.deleteMany({ where: { examId: { in: examIds } } })
  await prisma.exam.deleteMany({ where: { id: { in: examIds } } })
  await prisma.performanceSnapshot.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await prisma.employeeTimeline.deleteMany({ where: { employeeId: { in: employeeIds } } })
  await prisma.question.deleteMany({ where: { tags: { has: DEMO_TAG } } })
  await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } })
  await prisma.userSession.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })

  console.log('Demo data removed.')
}

async function create() {
  const [outlets, departments, designations] = await Promise.all([
    prisma.outlet.findMany(),
    prisma.department.findMany(),
    prisma.designation.findMany(),
  ])

  /**
   * Fail with the code that was not found, rather than letting an undefined
   * reach Prisma and surface as "cannot read properties of undefined".
   */
  const lookup = <T extends { code: string }>(list: T[], code: string, kind: string): T => {
    const found = list.find((row) => row.code === code)
    if (!found) {
      throw new Error(
        `Unknown ${kind} code "${code}". Available: ${list.map((r) => r.code).join(', ')}. ` +
          `Run \`npm run db:seed\` if the reference data is missing.`
      )
    }
    return found
  }

  const outletBy = (code: string) => lookup(outlets, code, 'outlet')
  const deptBy = (code: string) => lookup(departments, code, 'department')
  const desigBy = (code: string) => lookup(designations, code, 'designation')

  // An author for the question bank. Prefer a real admin if one exists so the
  // "created by" attribution is not itself demo data.
  const author =
    (await prisma.user.findFirst({ where: { role: { in: ['super_admin', 'admin'] } } })) ??
    (await prisma.user.create({
      data: {
        phone: String(PHONE_BASE),
        role: 'admin',
        passwordHash: await hashPassword(DEMO_PASSWORD),
        isActive: true,
        mustChangePassword: false,
      },
    }))

  console.log('Creating staff…')
  const passwordHash = await hashPassword(DEMO_PASSWORD)
  const employees = []

  for (const [i, person] of STAFF.entries()) {
    const phone = String(PHONE_BASE + 1 + i)
    const outlet = outletBy(person.outlet)
    const department = deptBy(person.dept)
    const designation = desigBy(person.desig)

    const user = await prisma.user.upsert({
      where: { phone },
      update: {},
      create: {
        phone,
        role: 'staff',
        passwordHash,
        isActive: true,
        mustChangePassword: false,
      },
    })

    const employee = await prisma.employee.upsert({
      where: { userId: user.id },
      update: {},
      create: {
        userId: user.id,
        employeeCode: `BK-${outlet.code}-${String(900 + i)}`,
        firstName: person.first,
        lastName: person.last,
        phone,
        outletId: outlet.id,
        departmentId: department.id,
        designationId: designation.id,
        joiningDate: new Date('2026-01-15'),
        employmentStatus: 'active',
        preferredLanguage: i % 3 === 1 ? 'hi' : i % 3 === 2 ? 'gu' : 'en',
      },
    })
    employees.push(employee)
  }
  console.log(`  ${employees.length} staff across ${new Set(STAFF.map((s) => s.outlet)).size} outlets`)

  console.log('Creating questions…')
  const kitchen = deptBy('KIT')
  const topic = await prisma.topic.upsert({
    where: { id: (await prisma.topic.findFirst({ where: { nameEn: 'Food Safety' } }))?.id ?? '00000000-0000-0000-0000-000000000000' },
    update: {},
    create: { nameEn: 'Food Safety', nameHi: 'खाद्य सुरक्षा', departmentId: kitchen.id },
  })

  const questions = []

  for (let i = 0; i < 4; i++) {
    questions.push(
      await prisma.question.create({
        data: {
          type: 'mcq',
          difficulty: i < 2 ? 'easy' : 'medium',
          topicId: topic.id,
          departmentId: kitchen.id,
          questionTextEn: `At what temperature must cold food be held? (${i + 1})`,
          questionTextHi: `ठंडा खाना किस तापमान पर रखा जाना चाहिए? (${i + 1})`,
          questionTextGu: i < 2 ? `ઠંડો ખોરાક કયા તાપમાને રાખવો જોઈએ? (${i + 1})` : null,
          explanationEn: 'The cold chain breaks above 4°C and bacteria multiply rapidly.',
          marks: 1,
          status: 'approved',
          approvedById: author.id,
          approvedAt: new Date(),
          sourceChapter: 'Chapter 3 — Cold chain',
          tags: [DEMO_TAG, 'food-safety'],
          options: MCQ_OPTIONS,
          createdById: author.id,
        },
      })
    )
  }

  questions.push(
    await prisma.question.create({
      data: {
        type: 'theory',
        difficulty: 'medium',
        topicId: topic.id,
        departmentId: kitchen.id,
        questionTextEn: 'Explain the cold chain and why it matters in a restaurant kitchen.',
        questionTextHi: 'कोल्ड चेन क्या है और रसोई में यह क्यों महत्वपूर्ण है?',
        expectedAnswerEn:
          'Food must stay below 4°C from delivery through storage to service. Any gap lets bacteria multiply, and the risk is cumulative — it does not reset when the food is chilled again.',
        minWordLimit: 20,
        maxWordLimit: 200,
        marks: 5,
        status: 'approved',
        approvedById: author.id,
        approvedAt: new Date(),
        sourceChapter: 'Chapter 3 — Cold chain',
        tags: [DEMO_TAG, 'food-safety'],
        createdById: author.id,
      },
    })
  )

  questions.push(
    await prisma.question.create({
      data: {
        type: 'video_image',
        difficulty: 'hard',
        topicId: topic.id,
        departmentId: kitchen.id,
        questionTextEn: 'Photograph a plated Margherita pizza to the house standard.',
        responseType: 'image',
        rubric: RUBRIC,
        marks: 10,
        status: 'approved',
        approvedById: author.id,
        approvedAt: new Date(),
        sourceChapter: 'Chapter 7 — Presentation',
        tags: [DEMO_TAG, 'presentation'],
        createdById: author.id,
      },
    })
  )
  console.log(`  ${questions.length} questions (4 MCQ, 1 theory, 1 video/image)`)

  console.log('Creating an exam…')
  const totalMarks = questions.reduce((sum, q) => sum + Number(q.marks), 0)
  const today = new Date()
  const scheduled = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))

  const exam = await prisma.exam.create({
    data: {
      nameEn: 'Monthly Kitchen Assessment',
      nameHi: 'मासिक रसोई मूल्यांकन',
      examCode: `${DEMO_EXAM_PREFIX}${today.getUTCFullYear()}-01`,
      scheduledDate: scheduled,
      startTime: new Date('1970-01-01T00:00:00.000Z'),
      endTime: new Date('1970-01-01T23:59:59.999Z'),
      departmentId: kitchen.id,
      totalMarks,
      passingPercentage: 40,
      durationMinutes: 60,
      shuffleQuestions: false,
      shuffleOptions: false,
      showResultImmediately: true,
      allowReview: true,
      status: 'scheduled',
      createdById: author.id,
      examQuestions: {
        create: questions.map((q, i) => ({ questionId: q.id, sortOrder: i, marks: Number(q.marks) })),
      },
    },
    include: { examQuestions: { orderBy: { sortOrder: 'asc' } } },
  })

  console.log('Creating attempts…')
  const kitchenStaff = employees.filter((_, i) => STAFF[i]!.dept === 'KIT')
  let waiting = 0

  for (const [i, employee] of kitchenStaff.entries()) {
    const now = new Date()
    const assignment = await prisma.examAssignment.create({
      data: {
        examId: exam.id,
        employeeId: employee.id,
        status: 'submitted',
        startedAt: new Date(now.getTime() - 45 * 60_000),
        submittedAt: new Date(now.getTime() - (i + 1) * 60 * 60_000),
      },
    })

    /**
     * The rows Module 7's submit produces: every question answered or skipped,
     * MCQs already scored, theory and video left NULL for a human. Written
     * directly rather than driven through the API because this script runs
     * without a server — but the shape is the one the grading screen expects.
     */
    for (const [qi, eq] of exam.examQuestions.entries()) {
      const question = questions[qi]!
      const correct = qi % 2 === 0 || i === 0

      if (question.type === 'mcq') {
        await prisma.examResponse.create({
          data: {
            examAssignmentId: assignment.id,
            examQuestionId: eq.id,
            questionId: question.id,
            responseType: 'mcq',
            selectedOptionId: correct ? 'a' : 'b',
            isCorrect: correct,
            marksObtained: correct ? Number(eq.marks) : 0,
            maxMarks: Number(eq.marks),
            isAutoGraded: true,
            answeredAt: assignment.submittedAt,
          },
        })
      } else if (question.type === 'theory') {
        await prisma.examResponse.create({
          data: {
            examAssignmentId: assignment.id,
            examQuestionId: eq.id,
            questionId: question.id,
            responseType: 'theory',
            theoryAnswer:
              i === 0
                ? 'Cold food has to stay under four degrees the whole way from delivery to the pass. If it warms up in between, bacteria grow, and chilling it again does not undo that.'
                : 'Keep the food cold so it does not spoil.',
            theoryAnswerLanguage: 'en',
            maxMarks: Number(eq.marks),
            // NULL: this is exactly what the grading queue looks for.
            answeredAt: assignment.submittedAt,
          },
        })
      } else {
        await prisma.examResponse.create({
          data: {
            examAssignmentId: assignment.id,
            examQuestionId: eq.id,
            questionId: question.id,
            responseType: 'video_image',
            mediaUrls: ['https://images.example.com/demo/margherita.jpg'],
            mediaType: 'image',
            maxMarks: Number(eq.marks),
            answeredAt: assignment.submittedAt,
          },
        })
      }
    }
    waiting++
  }

  // The rest are assigned but have not sat it yet.
  for (const employee of employees.filter((e) => !kitchenStaff.includes(e))) {
    await prisma.examAssignment.create({
      data: { examId: exam.id, employeeId: employee.id, status: 'notified' },
    })
  }

  await prisma.exam.update({
    where: { id: exam.id },
    data: { totalAssigned: employees.length, totalAttempted: waiting },
  })

  console.log(`  1 exam, ${employees.length} assigned, ${waiting} awaiting grading`)
  console.log('\nDemo data ready. Sign in as any of:')
  for (const [i, person] of STAFF.entries()) {
    console.log(`  ${PHONE_BASE + 1 + i}  ${person.first} ${person.last} (staff, ${person.outlet})`)
  }
  console.log(`  password for all: ${DEMO_PASSWORD}\n`)
}

async function main() {
  if (process.argv.includes('--clear')) {
    await clear()
  } else {
    await create()
  }
}

main()
  .catch((err: unknown) => {
    console.error('Demo data failed:', err)
    process.exit(1)
  })
  .finally(() => void prisma.$disconnect())
