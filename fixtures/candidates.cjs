"use strict";

// Hand-written samples. IDs, names, organizations, and text are all synthetic.
const recommendCandidate = {
  geekId: "synthetic-geek-001",
  haveChatted: "false",
  hlmatches: [{ content: "今日活跃" }],
  recLabels: [{ name: "Fixture label" }],
  geekCard: {
    encGeekId: "synthetic-encrypted-geek-001",
    securityId: "synthetic-security-recommend-001",
    encryptJobId: "synthetic-job-001",
    encryptExpectId: "synthetic-expect-001",
    lid: "synthetic-list-001",
    geekName: "Fixture Person",
    ageDesc: "26岁",
    geekWorkYear: "3年",
    geekDegree: "本科",
    salary: "15-20K",
    expectPositionName: "Backend engineer",
    expectLocationName: "示例城市",
    applyStatusDesc: "在职-考虑机会",
    geekDesc: "Build reliable services.\nKeep original paragraphs.",
    tags: ["Node.js", { name: "Testing" }],
    geekWorks: [{
      company: "Fixture Systems",
      positionName: "Backend engineer",
      startDate: "20250101",
      endDate: "20260901",
      responsibility: "List excerpt.\nSecond list paragraph.",
      workEmphasisList: [{ name: "Node.js" }]
    }, {
      company: "Fixture Previous Company",
      positionName: "Engineer",
      startYearMonStr: "2023.01",
      endYearMonStr: "2024.12",
      workContent: "An earlier listed job."
    }],
    geekEdus: [{
      school: "Fixture University",
      major: "Computer science",
      degreeName: "本科",
      startYearStr: "2019",
      endYearStr: "2023"
    }]
  }
};

const featuredCandidate = {
  haveChatted: false,
  geekCard: {
    geekId: 0,
    encryptUserId: "synthetic-encrypted-user-002",
    securityId: "synthetic-security-featured-002",
    geekName: "Fixture Person",
    geekWorks: null,
    geekEdus: null,
    workList: null,
    geekDesc: "A featured card without work or education arrays.",
    expectText: "Frontend engineer",
    salaryDesc: "12-18K",
    labels: [{ name: "Fixture featured label" }]
  }
};

const recommendResumeDetail = {
  alreadyInterested: false,
  geekDetail: {
    securityId: "synthetic-security-recommend-001",
    geekBaseInfo: {
      geekId: "synthetic-geek-001",
      encryptGeekId: "synthetic-encrypted-geek-001",
      name: "Fixture Person",
      ageDesc: "26岁",
      gender: 1,
      degreeCategory: "本科",
      workYearDesc: "3年",
      freshGraduate: 0,
      workDate8: "20230101",
      applyStatusContent: "在职-考虑机会"
    },
    geekAdvantage: "<p>Build reliable services.</p><p>Keep original paragraphs.</p>",
    professionalSkill: "Synthetic free-text professional skill.",
    geekWorkExpList: [{
      company: "Fixture Systems",
      department: "Synthetic platform team",
      positionName: "Backend engineer",
      startYearMonStr: "2025.01",
      endYearMonStr: "2026.09",
      responsibility: "<p>First responsibility paragraph.</p><p>Second responsibility paragraph.</p>",
      workContent: "A separate work-content field.",
      workPerformance: "Reduced synthetic queue latency by 12%.",
      performance: "A separate performance field.",
      description: "A detailed description.",
      workDesc: "A separate work-description field.",
      workEmphasis: "A supplementary note.",
      workEmphasisList: [{ name: "SQL" }, { name: "Node.js" }]
    }, {
      company: "Fixture Internship",
      positionName: "Intern",
      startDate: "20220701",
      endDate: "20221201",
      responsibility: "An older experience absent from the list."
    }],
    geekEduExpList: [{
      school: "Fixture University",
      major: "Computer science",
      degreeName: "本科",
      startYearStr: "2019",
      endYearStr: "2023",
      eduDescription: "<p>Education paragraph one.</p><p>Education paragraph two.</p>",
      courseDesc: "Distributed systems",
      keySubjectList: [{ subjectName: "Compilers" }],
      thesisTitle: "Synthetic retry scheduling",
      thesisDesc: "A synthetic thesis description.",
      schoolTags: [{ name: "Fixture school label" }]
    }],
    geekProjExpList: [{
      name: "Fixture Queue",
      roleName: "Developer",
      startDate: "20250101",
      endDate: "20250601",
      description: "A synthetic project.\nIts second paragraph.",
      projectResponsibility: "Implemented retry handling.",
      projectPerformance: "Published a synthetic benchmark.",
      url: "https://example.invalid/fixture-queue"
    }],
    geekExpectList: [{
      positionName: "Backend engineer",
      locationName: "示例城市",
      salaryDesc: "15-20K",
      industryDesc: "Software"
    }],
    geekSkillList: [{ skillName: "Node.js", levelName: "熟练" }],
    geekCertificationList: [{ certName: "Synthetic certificate" }],
    geekHonorList: [{ honorName: "Synthetic award" }],
    workExpCheckRes: [{ desc: "Synthetic source notice.", firstTip: "Synthetic supplementary notice." }]
  }
};

const featuredResumeDetail = {
  geekDetail: {
    securityId: "synthetic-security-featured-rotated-002",
    geekBaseInfo: {
      geekId: "synthetic-geek-002",
      encryptGeekId: "synthetic-encrypted-geek-002",
      name: "Fixture Person",
      degreeCategory: "本科"
    },
    geekWorkExpList: [{
      company: "Fixture Interface Company",
      positionName: "Frontend engineer",
      startYearMonStr: "2024.01",
      endYearMonStr: "2026.08",
      responsibility: "Details exist even though the featured list arrays are null."
    }],
    geekEduExpList: [],
    geekProjExpList: [],
    geekExpPosList: [{ positionName: "Frontend engineer", cityName: "示例城市", salaryDesc: "12-18K" }]
  }
};

const emptyResumeDetail = {
  geekDetail: {
    geekWorkExpList: [],
    geekEduExpList: [],
    geekProjExpList: []
  }
};

module.exports = {
  recommendCandidate,
  featuredCandidate,
  recommendResumeDetail,
  featuredResumeDetail,
  emptyResumeDetail
};
