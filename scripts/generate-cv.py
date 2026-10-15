#!/usr/bin/env python3
"""Gera o CV em inglês e espanhol (dashboard/cv/), no mesmo layout do CV em português.

O português (Leandro_Huber_CV_Sistemas_Distribuidos.pdf) é o original, copiado como está.
Uso: python3 scripts/generate-cv.py
Precisa de reportlab e da fonte Carlito (cai em DejaVu Sans se não achar).
"""
import glob
import os
import re
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import HRFlowable, KeepTogether, ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

OUT = os.path.join(os.path.dirname(__file__), '..', 'dashboard', 'cv')
BLUE, DARK, GRAY, LINK = colors.HexColor('#1a73e8'), colors.HexColor('#1b3a6b'), colors.HexColor('#666666'), colors.HexColor('#1a56b0')


def find_font(name, fallback):
    for pattern in (f'/usr/share/fonts/**/{name}', os.path.expanduser(f'~/.local/share/flatpak/runtime/**/{name}'), f'/var/lib/flatpak/runtime/**/{name}'):
        hits = glob.glob(pattern, recursive=True)
        if hits:
            return hits[0]
    return glob.glob(f'/usr/share/fonts/**/{fallback}', recursive=True)[0]


pdfmetrics.registerFont(TTFont('Body', find_font('Carlito-Regular.ttf', 'DejaVuSans.ttf')))
pdfmetrics.registerFont(TTFont('Body-Bold', find_font('Carlito-Bold.ttf', 'DejaVuSans-Bold.ttf')))
pdfmetrics.registerFont(TTFont('Sym', find_font('DejaVuSans.ttf', 'DejaVuSans.ttf')))
pdfmetrics.registerFontFamily('Body', normal='Body', bold='Body-Bold', italic='Body', boldItalic='Body-Bold')


def s(name, **kw):
    base = dict(fontName='Body', fontSize=9, leading=12.2, textColor=colors.HexColor('#222222'), alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(name, **base)


ST = {
    'name': s('name', fontName='Body-Bold', fontSize=20, leading=23, textColor=colors.HexColor('#111111')),
    'title': s('title', fontName='Body-Bold', fontSize=10.5, leading=13, textColor=BLUE),
    'contact': s('contact', fontSize=8.3, leading=11, textColor=GRAY),
    'h': s('h', fontName='Body-Bold', fontSize=10, leading=13, textColor=DARK),
    'p': s('p', spaceAfter=3),
    'job': s('job', fontName='Body-Bold', spaceBefore=3, spaceAfter=1.5),
    'b': s('b'),
    'boxTag': s('boxTag', fontName='Body-Bold', fontSize=6.8, leading=9, textColor=BLUE),
    'boxTitle': s('boxTitle', fontName='Body-Bold', fontSize=11, leading=14, textColor=colors.HexColor('#1f2a44')),
}


def fmt(text):
    """Marca símbolos que a Carlito não tem (▶ → ≥) para usar DejaVu e deixa links azuis."""
    text = re.sub(r'([▶→≥])', r'<font name="Sym" size="7.5">\1</font>', text)
    return text


def link(url, label=None):
    href = url if url.startswith('http') else f'https://{url}'
    return f'<link href="{href}" color="#1a56b0"><u>{label or url}</u></link>'


def bullets(items):
    return ListFlowable([ListItem(Paragraph(fmt(i), ST['b']), leftIndent=10, bulletColor=GRAY) for i in items],
                        bulletType='bullet', start='•', bulletFontSize=8, leftIndent=10, bulletOffsetY=-0.5)


def heading(text):
    return [Spacer(1, 6), Paragraph(text.upper(), ST['h']), HRFlowable(width='100%', thickness=0.8, color=DARK, spaceBefore=1, spaceAfter=4)]


DEMO, REPO = 'www.leandrohuber.freeddns.org', 'github.com/Leandrodasilvahuber/lab_dist_system'

CV = {
    'en': dict(
        file='Leandro_Huber_CV_Distributed_Systems_EN.pdf', doc='Leandro Huber — Distributed Systems CV',
        title='Senior Software Engineer | Distributed Systems · Event-Driven · Kafka · AWS',
        place='Florianópolis (SC), Brazil',
        demo='▶ Live demo:',
        summary_h='Professional summary',
        summary=[
            'Senior software engineer with 15+ years of experience, focused on distributed systems: microservices, messaging, cross-service consistency and production operations. I architected Kafka integrations that process events from every court district in Minas Gerais and microservices for a platform that monitors more than 500 thousand hectares of soy.',
            'In my public lab on AWS — with a live demo — every purchase is a saga with automatic compensation, end-to-end idempotency and measured SLOs, and I inject failures on purpose to prove everything recovers. Retries, backoff, DLQs and the 3 a.m. alarm are part of my daily routine.'],
        box_tag='FEATURED PROJECT · RUNNING IN PRODUCTION ON AWS',
        box_title='Distributed Systems Playground', box_sub=' — 5 services, saga and chaos engineering',
        code='Code:',
        box=[
            '100% serverless e-commerce with five independent services (Products, Orders, Payments, Stock, Saga), each with its own DynamoDB tables (<b>database per service</b>).',
            'Purchase modeled as a Step Functions saga: CreateOrder → ReserveStock → ProcessPayment → CommitReservation → ConfirmOrder, with reverse-order compensation and reconciliation of stuck sagas.',
            '<b>End-to-end idempotency</b> (Idempotency-Key, conditional and transactional writes), domain events on EventBridge with Archive for auditing, and DLQ with redrive.',
            '<b>SLOs defined</b> (p95 &lt; 2 s; ≥ 99.5% of sagas completed or compensated), latency, throttling and failure injection per service, and a cost kill switch with AWS Budgets.'],
        skills_h='Technical skills',
        skills=[
            '<b>Distributed patterns:</b> microservices, event-driven architecture, Saga (orchestration and compensation), idempotency, retry with backoff, circuit breaker, DLQ and redrive, database per service',
            '<b>Messaging &amp; orchestration:</b> Kafka, RabbitMQ, AWS EventBridge, SQS, Step Functions',
            '<b>Distributed databases &amp; NoSQL:</b> Cassandra, DynamoDB, MongoDB, Neo4j, Redis, ElasticSearch',
            '<b>Relational databases:</b> PostgreSQL, MySQL',
            '<b>Cloud &amp; infrastructure:</b> AWS (Lambda, API Gateway, DynamoDB, CloudWatch, X-Ray, Cognito, S3, CloudFront, Budgets), AWS SAM, Docker, LocalStack, DigitalOcean, GitHub Actions, CI/CD',
            '<b>Observability &amp; reliability:</b> structured logs, EMF metrics, distributed tracing (X-Ray, correlationId), alarms, SLOs, chaos engineering',
            '<b>Languages:</b> Node.js, TypeScript, PHP (Laravel), Java (Spring Boot)',
            '<b>Security:</b> Cognito/JWT, Semgrep, Gitleaks, Checkov, OWASP ZAP',
            '<b>AI-Assisted Development:</b> GitHub Copilot, MCP (Model Context Protocol), Prompt Engineering'],
        exp_h='Professional experience',
        jobs=[
            ('Senior Full Stack Developer | Hammer Consult', '06/2023 – Present', [
                'Architected Kafka integrations for high-scale asynchronous event processing, supporting data from every court district in Minas Gerais.',
                'Defined distributed caching strategies with Redis for critical applications.',
                'Lead deployment and operation of applications on AWS and DigitalOcean.',
                'Build MCPs that automate internal processes, including automatic image identification.',
                'Lead the adoption of GitHub Copilot and AI-assisted development in the team, shortening feature delivery time across sprints.']),
            ('Mid-level Full Stack Developer | Digifarmz (agtech)', '03/2021 – 04/2023', [
                'Technical reference for the microservices architecture and RESTful APIs of a platform that monitors more than 500 thousand hectares of soy.',
                'Configured and maintained Kafka topics for asynchronous communication between distributed services.',
                'Rolled out CI/CD pipelines that cut rollbacks by 90% and raised release quality by 20%.',
                'Handled deployment, scaling and continuous production monitoring on AWS.']),
            ('Backend Developer | Datacempro', '07/2017 – 01/2021', [
                'Built and evolved critical modules of enterprise management systems in Java, JavaScript and PHP.']),
            ('Backend Programmer | F1 Soluções', '10/2015 – 06/2017', [
                'Built backend applications in Node.js and CakePHP and optimized high-performance MySQL databases.'])],
        earlier='<b>Earlier experience (2007 – 2015):</b> Spotcom (engineering team of 100+ people, external API integration), N2 Agência Web, Sygecom and Datacempro.',
        other_h='Other projects',
        other_title='AI Orchestrator (writing)',
        other=['Pipeline in Spring Boot (Java 17) and React that fetches news via RSS, writes and illustrates content with AI (Groq, Gemini, Mistral) and publishes automatically to a blog and LinkedIn.'],
        edu_h='Education and languages',
        edu=['Associate degree in Systems Analysis and Development — UNIASSELVI (2025)',
             'Portuguese native · English A2 — advanced technical reading; conversation in development',
             'Immediately available · contractor (PJ) or employee (CLT)']),
    'es': dict(
        file='Leandro_Huber_CV_Sistemas_Distribuidos_ES.pdf', doc='Leandro Huber — CV Sistemas Distribuidos',
        title='Ingeniero de Software Sénior | Sistemas Distribuidos · Event-Driven · Kafka · AWS',
        place='Florianópolis (SC), Brasil',
        demo='▶ Demo en vivo:',
        summary_h='Resumen profesional',
        summary=[
            'Ingeniero de software sénior con más de 15 años de experiencia y foco en sistemas distribuidos: microservicios, mensajería, consistencia entre servicios y operación en producción. Diseñé integraciones Kafka que procesan eventos de todos los juzgados de Minas Gerais y microservicios de una plataforma que monitorea más de 500 mil hectáreas de soja.',
            'En mi laboratorio público en AWS — con demo en vivo — cada compra es una saga con compensación automática, idempotencia de extremo a extremo y SLOs medidos, e inyecto fallos a propósito para demostrar que todo se recupera. Retry, backoff, DLQ y la alarma de las 3 de la mañana son parte de mi día a día.'],
        box_tag='PROYECTO DESTACADO · FUNCIONANDO EN PRODUCCIÓN EN AWS',
        box_title='Distributed Systems Playground', box_sub=' — 5 servicios, saga e ingeniería del caos',
        code='Código:',
        box=[
            'E-commerce 100% serverless con cinco servicios independientes (Products, Orders, Payments, Stock, Saga), cada uno con sus propias tablas en DynamoDB (<b>database per service</b>).',
            'Compra modelada como saga en Step Functions: CreateOrder → ReserveStock → ProcessPayment → CommitReservation → ConfirmOrder, con compensación en orden inverso y reconciliación de sagas atascadas.',
            '<b>Idempotencia de extremo a extremo</b> (Idempotency-Key, escrituras condicionales y transaccionales), eventos de dominio en EventBridge con Archive para auditoría y DLQ con redrive.',
            '<b>SLOs definidos</b> (p95 &lt; 2 s; ≥ 99,5% de las sagas completadas o compensadas), inyección de latencia, throttling y fallos por servicio, y kill switch de costos con AWS Budgets.'],
        skills_h='Competencias técnicas',
        skills=[
            '<b>Patrones distribuidos:</b> microservicios, arquitectura orientada a eventos, Saga (orquestación y compensación), idempotencia, retry con backoff, circuit breaker, DLQ y redrive, database per service',
            '<b>Mensajería y orquestación:</b> Kafka, RabbitMQ, AWS EventBridge, SQS, Step Functions',
            '<b>Bases distribuidas y NoSQL:</b> Cassandra, DynamoDB, MongoDB, Neo4j, Redis, ElasticSearch',
            '<b>Bases relacionales:</b> PostgreSQL, MySQL',
            '<b>Cloud e infraestructura:</b> AWS (Lambda, API Gateway, DynamoDB, CloudWatch, X-Ray, Cognito, S3, CloudFront, Budgets), AWS SAM, Docker, LocalStack, DigitalOcean, GitHub Actions, CI/CD',
            '<b>Observabilidad y confiabilidad:</b> logs estructurados, métricas EMF, tracing distribuido (X-Ray, correlationId), alarmas, SLOs, ingeniería del caos',
            '<b>Lenguajes:</b> Node.js, TypeScript, PHP (Laravel), Java (Spring Boot)',
            '<b>Seguridad:</b> Cognito/JWT, Semgrep, Gitleaks, Checkov, OWASP ZAP',
            '<b>AI-Assisted Development:</b> GitHub Copilot, MCP (Model Context Protocol), Prompt Engineering'],
        exp_h='Experiencia profesional',
        jobs=[
            ('Desarrollador Full Stack Sénior | Hammer Consult', '06/2023 – Actual', [
                'Diseñé integraciones vía Kafka para el procesamiento asíncrono de eventos a gran escala, sosteniendo los datos de todos los juzgados de Minas Gerais.',
                'Definí estrategias de caché distribuida con Redis para aplicaciones críticas.',
                'Conduzco el despliegue y la operación de aplicaciones en AWS y DigitalOcean.',
                'Desarrollo MCPs que automatizan procesos internos, incluida la identificación automática de imágenes.',
                'Lidero la adopción de GitHub Copilot y del desarrollo asistido por IA en el equipo, reduciendo el tiempo de entrega de features a lo largo de los sprints.']),
            ('Desarrollador Full Stack Pleno | Digifarmz (agtech)', '03/2021 – 04/2023', [
                'Fui referente técnico en la arquitectura de microservicios y APIs RESTful de una plataforma que monitorea más de 500 mil hectáreas de soja.',
                'Configuré y mantuve tópicos Kafka para la comunicación asíncrona entre servicios distribuidos.',
                'Implanté pipelines de CI/CD que redujeron los rollbacks en 90% y elevaron la calidad de los releases en 20%.',
                'Conduje despliegue, escalabilidad y monitoreo continuo en producción en AWS.']),
            ('Desarrollador Backend | Datacempro', '07/2017 – 01/2021', [
                'Desarrollé y evolucioné módulos críticos de sistemas de gestión empresarial en Java, JavaScript y PHP.']),
            ('Programador Backend | F1 Soluções', '10/2015 – 06/2017', [
                'Desarrollé aplicaciones backend en Node.js y CakePHP y optimicé bases MySQL de alto rendimiento.'])],
        earlier='<b>Experiencia anterior (2007 – 2015):</b> Spotcom (equipo de ingeniería de 100+ personas, integración de APIs externas), N2 Agência Web, Sygecom y Datacempro.',
        other_h='Otros proyectos',
        other_title='Orquestador IA (redacción)',
        other=['Pipeline en Spring Boot (Java 17) y React que busca noticias vía RSS, redacta e ilustra contenido con IA (Groq, Gemini, Mistral) y publica automáticamente en un blog y en LinkedIn.'],
        edu_h='Formación e idiomas',
        edu=['Tecnólogo en Análisis y Desarrollo de Sistemas — UNIASSELVI (2025)',
             'Portugués nativo · Inglés A2 — lectura técnica avanzada; conversación en desarrollo',
             'Disponibilidad inmediata · PJ o CLT (contratista o empleado)']),
}


def build(c):
    doc = SimpleDocTemplate(os.path.join(OUT, c['file']), pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm, title=c['doc'], author='Leandro Huber')
    f = [Paragraph('LEANDRO HUBER', ST['name']), Paragraph(c['title'], ST['title']), Spacer(1, 1.5),
         Paragraph(f"{c['place']} · (48) 98811-4351 · {link('mailto:emaildohuber@gmail.com', 'emaildohuber@gmail.com')} · "
                   f"{link('linkedin.com/in/leandrohuber')} · {link('github.com/Leandrodasilvahuber')}", ST['contact']),
         Paragraph(fmt(f"<b>{c['demo']}</b> <b>{link(DEMO)}</b>"), ST['contact'])]
    f += heading(c['summary_h']) + [Paragraph(t, ST['p']) for t in c['summary']]

    box = [Paragraph(c['box_tag'], ST['boxTag']),
           Paragraph(f"{c['box_title']}<font name='Body' size='9' color='#555555'>{c['box_sub']}</font>", ST['boxTitle']),
           Paragraph(fmt(f"<b>{c['demo']}</b> {link(DEMO)} &nbsp;&nbsp; <b>{c['code']}</b> {link(REPO)}"), ST['b']),
           Spacer(1, 2), bullets(c['box'])]
    t = Table([[box]], colWidths=[doc.width])
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), colors.HexColor('#eef4fd')), ('BOX', (0, 0), (-1, -1), 0.6, colors.HexColor('#c5d8f5')),
                           ('LINEBEFORE', (0, 0), (0, -1), 2.5, BLUE), ('LEFTPADDING', (0, 0), (-1, -1), 8), ('RIGHTPADDING', (0, 0), (-1, -1), 8),
                           ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5)]))
    f += [Spacer(1, 3), t]
    f += heading(c['skills_h']) + [bullets(c['skills'])]
    f += heading(c['exp_h'])
    for role, when, items in c['jobs']:
        f += [KeepTogether([Paragraph(f"{role} <font name='Body' color='#555555'>— {when}</font>", ST['job']), bullets(items)])]
    f += [Spacer(1, 2), Paragraph(c['earlier'], ST['p'])]
    f += heading(c['other_h']) + [Paragraph(f"<b>{c['other_title']}</b>", ST['p']), bullets(c['other'])]
    f += heading(c['edu_h']) + [bullets(c['edu'])]
    doc.build(f)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for lang in CV.values():
        build(lang)
        print('ok', lang['file'])
