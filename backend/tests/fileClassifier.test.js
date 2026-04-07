import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import XLSX from 'xlsx';
import { classifyFile, extractHeadersFromFile } from '../services/fileClassifier.js';

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shakti-file-classifier-'));
  tempDirs.push(dir);
  return dir;
};

const writeCsvFixture = (fileName, contents) => {
  const dir = createTempDir();
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
};

const writeXlsxFixture = (fileName, rows) => {
  const dir = createTempDir();
  const filePath = path.join(dir, fileName);
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  XLSX.writeFile(workbook, filePath);
  return filePath;
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('fileClassifier', () => {
  it('finds the real CDR header row after metadata and accepts the file', () => {
    const filePath = writeCsvFixture('cdr.csv', [
      'Ticket Number :,LEA00000000000022867458',
      'Input Value (MSISDN/B PARTY/IMEI/IMSI/CELL ID) :,9173917306',
      'Date Range :,2023-11-08 00:00:00 to 2025-11-07 16:42:31',
      '',
      'Calling Party Telephone Number,Called Party Telephone Number,Call Date,Call Time,Call Duration,First Cell ID,IMEI,IMSI,Call Type',
      '919173917306,918160936114,08/11/2023,00:02:23,54,4058570192a31,350666979490310,405857092233275,a_out'
    ].join('\n'));

    const headers = extractHeadersFromFile(filePath, 'cdr');
    const classification = classifyFile(headers, 'cdr');

    expect(headers).toContain('Calling Party Telephone Number');
    expect(classification.result).toBe('ACCEPTED');
    expect(classification.detectedType).toBe('cdr');
  });

  it('finds the tower dump header row after banner lines and accepts the file', () => {
    const filePath = writeCsvFixture('tower.csv', [
      'BHARTI AIRTEL LIMITED',
      '""',
      'GUJARAT',
      'Call Details of CELL ID 404-98-8473-231484161',
      'Target No,Call Type,TOC,B Party No,LRN No,Date,Time,Dur(s),First CGI,Last CGI,IMEI,IMSI',
      '9414397023,SMT,Pre,VM-BOBCRD-S,,30/06/2025,00:13:37,0,404-98-8473-231484161,,356537896023590,404701094617921'
    ].join('\n'));

    const headers = extractHeadersFromFile(filePath, 'tower_dump');
    const classification = classifyFile(headers, 'tower_dump');

    expect(headers).toContain('Target No');
    expect(classification.result).toBe('ACCEPTED');
    expect(classification.detectedType).toBe('tower_dump');
  });

  it('accepts IPDR headers from the normalization aliases', () => {
    const filePath = writeCsvFixture('ipdr.csv', [
      'Name of Person/Organization,Address,Landline/MSISDN/MDN/Leased Circuit ID for Internet Access,User Id for internet Access based on authentication,Source IP Address,Source Port,Translated IP Address,Destination IP Address,TIME1 (dd/MM/yyyy HH:mm:ss),IMSI,First CELL ID',
      'John Doe,Ahmedabad,919242202917,919242202917,2409:40e4:003c:e906:8000:0000:0000:0000,45662,,2001:b28:f23f:f005::a,13/05/2025 19:17:08,405840180879111,4058560c7d50010'
    ].join('\n'));

    const headers = extractHeadersFromFile(filePath, 'ipdr');
    const classification = classifyFile(headers, 'ipdr');

    expect(classification.result).toBe('ACCEPTED');
    expect(classification.detectedType).toBe('ipdr');
  });

  it('accepts SDR and ILD spreadsheet headers from real sample aliases', () => {
    const sdrPath = writeXlsxFixture('sdr.xlsx', [
      ['Mobile Number', 'Activation Date', 'Name', 'Permanent Address of the Subscriber', 'Email'],
      ['8511131701', '27/04/2021', 'Varsha Trivedi', 'Ahmedabad', 'varsha@example.com']
    ]);
    const ildPath = writeXlsxFixture('ild.xlsx', [
      ['ILD', 'B Party', 'Date', 'Time', 'Duration', 'Call Type', 'Country', 'IMEI', 'IMSI'],
      ['971589020772', '8619928554', '01/Jan/2024', '14:17:12', '30', 'CALL_IN', 'United Arab Emirates', '', '']
    ]);

    const sdrClassification = classifyFile(extractHeadersFromFile(sdrPath, 'sdr'), 'sdr');
    const ildClassification = classifyFile(extractHeadersFromFile(ildPath, 'ild'), 'ild');

    expect(sdrClassification.result).toBe('ACCEPTED');
    expect(sdrClassification.scores.sdr.requiredCoverage).toBe(1);
    expect(ildClassification.result).toBe('ACCEPTED');
    expect(ildClassification.detectedType).toBe('ild');
    expect(ildClassification.scores.ild.requiredCoverage).toBe(1);
  });

  it('suggests the CDR section when a CDR file is uploaded in the SDR slot', () => {
    const filePath = writeCsvFixture('cdr-as-sdr.csv', [
      'Calling Party Telephone Number,Called Party Telephone Number,Call Date,Call Time,Call Duration',
      '919173917306,918160936114,08/11/2023,00:02:23,54'
    ].join('\n'));

    const headers = extractHeadersFromFile(filePath, 'sdr');
    const classification = classifyFile(headers, 'sdr');

    expect(classification.result).toBe('WRONG_TYPE');
    expect(classification.detectedType).toBe('cdr');
    expect(classification.message).toContain('CDR section');
  });

  it('accepts the previously rejected sample-style CDR, IPDR, and ILD headers', () => {
    const cdrPath = writeCsvFixture('sample-cdr.csv', [
      'Case metadata line',
      'Target /A PARTY NUMBER,CALL_TYPE,Type of Connection,B PARTY NUMBER,LRN- B Party Number,Translation of LRN,Call date,Call Initiation Time,Call Duration,First BTS Location,First Cell Global Id,Last BTS Location,IMEI,IMSI',
      '919999999999,VOICE,PREPAID,918888888888,12345,XYZ,01/01/2025,10:11:12,60,Somewhere,4058570192a31,Somewhere Else,350666979490310,405857092233275'
    ].join('\n'));
    const ipdrPath = writeCsvFixture('sample-ipdr.csv', [
      'SR.NO.,IMSI,IMEI,MSISDN,MAC ID,Source IP,Source Port,Destination IP,Destination Port,Translated IP,Translated Port,First Cell ID-Name/Location,Event_Start_Time',
      '1,405840180879111,356537896023590,919242202917,AA:BB,10.0.0.1,45662,20.0.0.1,443,30.0.0.1,55000,Cell A,2025-05-13 19:17:08'
    ].join('\n'));
    const ildPath = writeCsvFixture('sample-ild.csv', [
      'CALL_TIME,CALL_DATE,CALLING_PARTY_NUMBER,CALLED_PARTY_NUMBER,CALL_DURATION_SEC,ORIG_SWITCH_ID,ORG_TRUNC_GROUP,TERM_TRUNC_GROUP,CALL_DIRECTION,CALL_TYPE,ORIG_CARR_NAME,TERM_CARR_NAME,Country',
      '14:17:12,01/01/2025,971589020772,8619928554,30,SW1,T1,T2,OUT,VOICE,Carrier A,Carrier B,United Arab Emirates'
    ].join('\n'));

    const cdrClassification = classifyFile(extractHeadersFromFile(cdrPath, 'cdr'), 'cdr');
    const ipdrClassification = classifyFile(extractHeadersFromFile(ipdrPath, 'ipdr'), 'ipdr');
    const ildClassification = classifyFile(extractHeadersFromFile(ildPath, 'ild'), 'ild');

    expect(cdrClassification.result).toBe('ACCEPTED');
    expect(ipdrClassification.result).toBe('ACCEPTED');
    expect(ildClassification.result).toBe('ACCEPTED');
  });
});
