#!/usr/bin/env python3
"""Gera o CV em português, inglês e espanhol (dashboard/cv/), todos no mesmo layout.

O texto em português é a referência; inglês e espanhol são a tradução dele.
Ao mudar o CV, atualize os três idiomas abaixo.
Uso: python3 scripts/generate-cv.py
Precisa de reportlab (usa Helvetica, a mesma fonte do original).
"""
import os
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import HRFlowable, KeepTogether, ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer

OUT = os.path.join(os.path.dirname(__file__), '..', 'dashboard', 'cv')
NAVY, TEXT, GRAY, LINK = colors.HexColor('#1f3864'), colors.HexColor('#222222'), colors.HexColor('#555555'), '#1a56b0'


def s(name, **kw):
    base = dict(fontName='Helvetica', fontSize=8.6, leading=11.4, textColor=TEXT, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(name, **base)


ST = {
    'name': s('name', fontName='Helvetica-Bold', fontSize=20, leading=24, textColor=NAVY, alignment=TA_CENTER),
    'title': s('title', fontName='Helvetica-Bold', fontSize=9.2, leading=12, alignment=TA_CENTER),
    'center': s('center', fontSize=8.3, leading=11, textColor=GRAY, alignment=TA_CENTER),
    'h': s('h', fontName='Helvetica-Bold', fontSize=10.5, leading=13, textColor=NAVY),
    'p': s('p', spaceAfter=2),
    'skill': s('skill', spaceAfter=1.2),
    'job': s('job', fontName='Helvetica-Bold', fontSize=9, leading=12, spaceBefore=5),
    'when': s('when', fontName='Helvetica-Oblique', fontSize=7.8, leading=10.5, textColor=GRAY, spaceAfter=1),
    'b': s('b'),
}


def link(url):
    return f'<link href="https://{url}" color="{LINK}">{url}</link>'


def bullets(items):
    return ListFlowable([ListItem(Paragraph(i, ST['b']), leftIndent=10) for i in items],
                        bulletType='bullet', start='•', bulletFontSize=8, leftIndent=10, bulletOffsetY=-0.5)


def heading(text):
    # keepWithNext: o título nunca fica sozinho no fim da página
    title, rule = Paragraph(text.upper(), ST['h']), HRFlowable(width='100%', thickness=0.8, color=NAVY, spaceBefore=1, spaceAfter=4)
    title.keepWithNext = rule.keepWithNext = 1
    return [Spacer(1, 7), title, rule]


SITE, REPO = 'leandrohuber.freeddns.org', 'github.com/Leandrodasilvahuber/lab_dist_system'

CV = {
    'pt': dict(
        file='Leandro_Huber_CV_Sistemas_Distribuidos_PT.pdf',
        doc='Leandro Huber - Engenheiro de Software Sênior',
        subject='Currículo - Engenheiro de Software Sênior | Backend | Full Stack | Sistemas Distribuídos',
        title='Engenheiro de Software Sênior | Backend e Full Stack | Sistemas Distribuídos',
        keywords='Node.js | TypeScript | PHP | Laravel | Apache Kafka | AWS | Microsserviços | Vue.js',
        place='Salvador, BA, Brasil',
        summary_h='Resumo profissional',
        summary='Engenheiro de Software Sênior com mais de 15 anos de experiência backend e full stack, focado em <b>sistemas distribuídos</b>, '
                '<b>microsserviços</b> e <b>arquitetura orientada a eventos</b> com <b>Node.js, TypeScript, PHP/Laravel, Apache Kafka e AWS</b>. '
                'Atuo da arquitetura ao deploy, com experiência em alta volumetria de dados e como referência técnica de arquitetura.',
        skills_h='Competências técnicas',
        skills=[
            ('Linguagens', 'TypeScript, JavaScript, PHP 8, Java, Go, SQL'),
            ('Backend', 'Node.js, Express.js, Laravel, Spring Boot, APIs REST (RESTful), GraphQL'),
            ('Arquitetura e mensageria', 'Microsserviços (microservices), arquitetura orientada a eventos (event-driven), Apache Kafka, '
                                         'RabbitMQ, AWS SQS, EventBridge, Step Functions, padrão Saga, idempotência, retry com backoff, DLQ'),
            ('Bancos de dados e busca', 'PostgreSQL, MySQL, MongoDB, DynamoDB, Redis (cache), Elasticsearch'),
            ('Cloud e DevOps', 'AWS (Lambda, API Gateway, EC2, S3, DynamoDB), serverless, AWS SAM, Docker, CI/CD, GitHub Actions, '
                               'LocalStack, DigitalOcean, Linux, Git'),
            ('Observabilidade e confiabilidade', 'AWS CloudWatch, AWS X-Ray (rastreamento distribuído), SLOs, engenharia de caos (chaos engineering)'),
            ('Frontend', 'Vue.js, React, HTML5, CSS3'),
            ('Dados e IA', 'Apache Airflow, dbt, ETL, pipelines de dados, LLMs, agentes de IA, MCP (Model Context Protocol), GitHub Copilot'),
            ('Qualidade, segurança e métodos ágeis', 'Testes unitários e de integração, Jest, PHPUnit, Larastan, DevSecOps '
                                                     '(Semgrep, Gitleaks, Checkov, OWASP ZAP), Clean Code, SOLID, Scrum, Kanban')],
        exp_h='Experiência profissional',
        jobs=[
            ('Desenvolvedor PHP / Laravel | Hammer Consult', '06/2023 - Atual | Remoto', [
                'Desenvolvo aplicações em PHP 8, Laravel e Vue.js para sistemas distribuídos com alta volumetria de dados.',
                'Implemento mensageria com Apache Kafka para processar, de forma assíncrona, eventos de todas as comarcas de Minas Gerais.',
                'Armazeno e indexo grandes volumes de dados com MongoDB e Elasticsearch para buscas rápidas sobre bases extensas.',
                'Aplico estratégias de cache com Redis para reduzir latência e carga em aplicações de alta demanda.',
                'Criei servidores MCP (Model Context Protocol) que automatizam processos e impulsionei o uso de GitHub Copilot no dia a dia do time.']),
            ('Desenvolvedor Full Stack Sênior | DigiFarmz', '03/2021 - 04/2023 | Remoto', [
                'Atuei como referência técnica da arquitetura de uma plataforma agtech que monitora mais de 1,5 milhão de hectares de soja, '
                'incluindo 500 mil hectares no Paraguai.',
                'Projetei e desenvolvi microsserviços e APIs RESTful em Laravel e Node.js, com frontend em Vue.js e React.',
                'Implementei comunicação assíncrona entre serviços distribuídos com tópicos Apache Kafka.',
                'Construí pipelines de CI/CD que <b>reduziram os rollbacks em 90% e elevaram a qualidade das releases em 20%</b>.',
                'Conduzi deploy, escalabilidade e monitoramento das aplicações em produção na AWS.']),
            ('Desenvolvedor Backend | Data Cempro Software', '07/2017 - 01/2021', [
                'Desenvolvi e evoluí módulos críticos de ERP em PHP, Java e JavaScript, com suporte técnico direto a clientes.']),
            ('Programador Backend | F1 Soluções', '10/2015 - 06/2017 | São Leopoldo, RS', [
                'Desenvolvi APIs e aplicações backend em Node.js e CakePHP e otimizei bancos MySQL de alta performance.']),
            ('Programador Full Stack | SPOT Monitoramento e Tecnologia', '03/2014 - 10/2015 | Porto Alegre, RS', [
                'Desenvolvi sistemas web em Java, JavaScript e PHP, com integração de APIs externas, em um time de engenharia '
                'com mais de 100 pessoas.'])],
        earlier_h='Experiência anterior (2007 - 2014)',
        earlier='Desenvolvedor Web/Java na N2 Agência Web (2013 - 2014) e Desenvolvedor XHarbour na SYGECOM (2009 - 2013) '
                'e na Data Cempro Software (2007 - 2008), em Porto Alegre, RS: sistemas web em PHP e JavaScript e '
                'sistemas de gestão empresarial em XHarbour e Webspeed.',
        proj_h='Projetos',
        projects=[
            ('Distributed Systems Playground (ao vivo na AWS)',
             'E-commerce serverless com 5 microsserviços em Node.js, AWS Lambda e DynamoDB. Padrão Saga no Step Functions com '
             'compensação, idempotência, EventBridge com DLQ, engenharia de caos e SLOs (p95 abaixo de 2 s, 99,5% das sagas '
             'concluídas ou compensadas). AWS SAM, X-Ray e DevSecOps (Semgrep, Gitleaks, Checkov, OWASP ZAP).',
             [f'{SITE}/laboratory', REPO]),
            ('HüberClaude (open source)',
             'Agente de código com IA para terminal Linux integrado ao OpenRouter: uma única chave de API dá acesso a milhares de '
             'modelos de IA (LLMs) com pagamento por uso.', [f'{SITE}/huberclaude']),
            ('Observatório de Combustíveis (ao vivo)',
             'Pipeline de dados (ETL) que publica o mapa de preços de gasolina, etanol, diesel e GNV por estado, atualizado '
             'automaticamente a cada 10 dias com dados abertos da ANP, por cerca de US$ 2,60/mês. Apache Airflow, dbt e AWS Lambda.',
             [f'{SITE}/gasolina']),
            ('Maya, tutora de inglês com IA (ao vivo)',
             'Aplicação com LLM que conduz conversas em inglês e corrige erros com explicações em português. Backend em Go com '
             'React embutido em um único binário, em contêiner Docker na AWS EC2.', [f'{SITE}/teacher']),
            ('James Tip (apresentado no Shark Tank Brasil)',
             'Um dos desenvolvedores da IA que identifica padrões de consumo e prevê vendas para otimizar estoque no varejo; '
             'o produto foi apresentado no Shark Tank Brasil e fechou rodada de investimento.', [])],
        edu_h='Formação acadêmica',
        edu='Tecnólogo em Análise e Desenvolvimento de Sistemas | UNIASSELVI | Concluído em 2025',
        courses_h='Cursos e certificações',
        courses='Treinamento DL - Desenvolvimento &amp; Liderança | INEXH - Instituto Nacional de Excelência Humana | 08/2020',
        lang_h='Idiomas',
        langs='Português: nativo | Inglês: básico (A2), com leitura técnica de documentação'),
    'en': dict(
        file='Leandro_Huber_CV_Distributed_Systems_EN.pdf',
        doc='Leandro Huber - Senior Software Engineer',
        subject='Resume - Senior Software Engineer | Backend | Full Stack | Distributed Systems',
        title='Senior Software Engineer | Backend and Full Stack | Distributed Systems',
        keywords='Node.js | TypeScript | PHP | Laravel | Apache Kafka | AWS | Microservices | Vue.js',
        place='Salvador, BA, Brazil',
        summary_h='Professional summary',
        summary='Senior Software Engineer with 15+ years of backend and full stack experience, focused on <b>distributed systems</b>, '
                '<b>microservices</b> and <b>event-driven architecture</b> with <b>Node.js, TypeScript, PHP/Laravel, Apache Kafka and AWS</b>. '
                'I work from architecture to deployment, with experience handling high data volumes and acting as the technical reference '
                'for architecture.',
        skills_h='Technical skills',
        skills=[
            ('Languages', 'TypeScript, JavaScript, PHP 8, Java, Go, SQL'),
            ('Backend', 'Node.js, Express.js, Laravel, Spring Boot, REST APIs (RESTful), GraphQL'),
            ('Architecture and messaging', 'Microservices, event-driven architecture, Apache Kafka, RabbitMQ, AWS SQS, EventBridge, '
                                           'Step Functions, Saga pattern, idempotency, retry with backoff, DLQ'),
            ('Databases and search', 'PostgreSQL, MySQL, MongoDB, DynamoDB, Redis (cache), Elasticsearch'),
            ('Cloud and DevOps', 'AWS (Lambda, API Gateway, EC2, S3, DynamoDB), serverless, AWS SAM, Docker, CI/CD, GitHub Actions, '
                                 'LocalStack, DigitalOcean, Linux, Git'),
            ('Observability and reliability', 'AWS CloudWatch, AWS X-Ray (distributed tracing), SLOs, chaos engineering'),
            ('Frontend', 'Vue.js, React, HTML5, CSS3'),
            ('Data and AI', 'Apache Airflow, dbt, ETL, data pipelines, LLMs, AI agents, MCP (Model Context Protocol), GitHub Copilot'),
            ('Quality, security and agile', 'Unit and integration testing, Jest, PHPUnit, Larastan, DevSecOps '
                                            '(Semgrep, Gitleaks, Checkov, OWASP ZAP), Clean Code, SOLID, Scrum, Kanban')],
        exp_h='Professional experience',
        jobs=[
            ('PHP / Laravel Developer | Hammer Consult', '06/2023 - Present | Remote', [
                'Build applications in PHP 8, Laravel and Vue.js for distributed systems with high data volumes.',
                'Implement Apache Kafka messaging to asynchronously process events from every court district in Minas Gerais.',
                'Store and index large data volumes with MongoDB and Elasticsearch for fast searches over extensive datasets.',
                'Apply Redis caching strategies to reduce latency and load on high-demand applications.',
                'Created MCP (Model Context Protocol) servers that automate processes and drove the daily use of GitHub Copilot across the team.']),
            ('Senior Full Stack Developer | DigiFarmz', '03/2021 - 04/2023 | Remote', [
                'Technical reference for the architecture of an agtech platform that monitors more than 1.5 million hectares of soy, '
                'including 500 thousand hectares in Paraguay.',
                'Designed and built microservices and RESTful APIs in Laravel and Node.js, with Vue.js and React frontends.',
                'Implemented asynchronous communication between distributed services with Apache Kafka topics.',
                'Built CI/CD pipelines that <b>cut rollbacks by 90% and raised release quality by 20%</b>.',
                'Led deployment, scaling and monitoring of production applications on AWS.']),
            ('Backend Developer | Data Cempro Software', '07/2017 - 01/2021', [
                'Built and evolved critical ERP modules in PHP, Java and JavaScript, with direct technical support to clients.']),
            ('Backend Programmer | F1 Soluções', '10/2015 - 06/2017 | São Leopoldo, RS', [
                'Built backend APIs and applications in Node.js and CakePHP and optimized high-performance MySQL databases.']),
            ('Full Stack Programmer | SPOT Monitoramento e Tecnologia', '03/2014 - 10/2015 | Porto Alegre, RS', [
                'Built web systems in Java, JavaScript and PHP, integrating external APIs, in an engineering team of more than 100 people.'])],
        earlier_h='Earlier experience (2007 - 2014)',
        earlier='Web/Java Developer at N2 Agência Web (2013 - 2014) and XHarbour Developer at SYGECOM (2009 - 2013) '
                'and at Data Cempro Software (2007 - 2008), in Porto Alegre, RS: web systems in PHP and JavaScript and '
                'business management systems in XHarbour and Webspeed.',
        proj_h='Projects',
        projects=[
            ('Distributed Systems Playground (live on AWS)',
             'Serverless e-commerce with 5 microservices in Node.js, AWS Lambda and DynamoDB. Saga pattern on Step Functions with '
             'compensation, idempotency, EventBridge with DLQ, chaos engineering and SLOs (p95 under 2 s, 99.5% of sagas completed '
             'or compensated). AWS SAM, X-Ray and DevSecOps (Semgrep, Gitleaks, Checkov, OWASP ZAP).',
             [f'{SITE}/laboratory', REPO]),
            ('HüberClaude (open source)',
             'AI coding agent for the Linux terminal integrated with OpenRouter: a single API key gives access to thousands of '
             'AI models (LLMs) with pay-per-use pricing.', [f'{SITE}/huberclaude']),
            ('Fuel Price Observatory (live)',
             'Data pipeline (ETL) that publishes a map of gasoline, ethanol, diesel and CNG prices by Brazilian state, updated '
             'automatically every 10 days with open data from ANP, for about US$ 2.60/month. Apache Airflow, dbt and AWS Lambda.',
             [f'{SITE}/gasolina']),
            ('Maya, AI English tutor (live)',
             'LLM application that leads conversations in English and corrects mistakes with explanations in Portuguese. Go backend '
             'with React embedded in a single binary, in a Docker container on AWS EC2.', [f'{SITE}/teacher']),
            ('James Tip (featured on Shark Tank Brasil)',
             'One of the developers of the AI that identifies consumption patterns and forecasts sales to optimize retail inventory; '
             'the product was pitched on Shark Tank Brasil and closed an investment round.', [])],
        edu_h='Education',
        edu='Associate degree in Systems Analysis and Development | UNIASSELVI | Completed in 2025',
        courses_h='Courses and certifications',
        courses='DL Training - Development &amp; Leadership | INEXH - Instituto Nacional de Excelência Humana | 08/2020',
        lang_h='Languages',
        langs='Portuguese: native | English: basic (A2), with technical reading of documentation'),
    'es': dict(
        file='Leandro_Huber_CV_Sistemas_Distribuidos_ES.pdf',
        doc='Leandro Huber - Ingeniero de Software Sénior',
        subject='Currículum - Ingeniero de Software Sénior | Backend | Full Stack | Sistemas Distribuidos',
        title='Ingeniero de Software Sénior | Backend y Full Stack | Sistemas Distribuidos',
        keywords='Node.js | TypeScript | PHP | Laravel | Apache Kafka | AWS | Microservicios | Vue.js',
        place='Salvador, BA, Brasil',
        summary_h='Resumen profesional',
        summary='Ingeniero de Software Sénior con más de 15 años de experiencia backend y full stack, enfocado en <b>sistemas distribuidos</b>, '
                '<b>microservicios</b> y <b>arquitectura orientada a eventos</b> con <b>Node.js, TypeScript, PHP/Laravel, Apache Kafka y AWS</b>. '
                'Trabajo de la arquitectura al despliegue, con experiencia en alto volumen de datos y como referente técnico de arquitectura.',
        skills_h='Competencias técnicas',
        skills=[
            ('Lenguajes', 'TypeScript, JavaScript, PHP 8, Java, Go, SQL'),
            ('Backend', 'Node.js, Express.js, Laravel, Spring Boot, APIs REST (RESTful), GraphQL'),
            ('Arquitectura y mensajería', 'Microservicios (microservices), arquitectura orientada a eventos (event-driven), Apache Kafka, '
                                          'RabbitMQ, AWS SQS, EventBridge, Step Functions, patrón Saga, idempotencia, retry con backoff, DLQ'),
            ('Bases de datos y búsqueda', 'PostgreSQL, MySQL, MongoDB, DynamoDB, Redis (caché), Elasticsearch'),
            ('Cloud y DevOps', 'AWS (Lambda, API Gateway, EC2, S3, DynamoDB), serverless, AWS SAM, Docker, CI/CD, GitHub Actions, '
                               'LocalStack, DigitalOcean, Linux, Git'),
            ('Observabilidad y confiabilidad', 'AWS CloudWatch, AWS X-Ray (trazabilidad distribuida), SLOs, ingeniería del caos (chaos engineering)'),
            ('Frontend', 'Vue.js, React, HTML5, CSS3'),
            ('Datos e IA', 'Apache Airflow, dbt, ETL, pipelines de datos, LLMs, agentes de IA, MCP (Model Context Protocol), GitHub Copilot'),
            ('Calidad, seguridad y métodos ágiles', 'Pruebas unitarias y de integración, Jest, PHPUnit, Larastan, DevSecOps '
                                                    '(Semgrep, Gitleaks, Checkov, OWASP ZAP), Clean Code, SOLID, Scrum, Kanban')],
        exp_h='Experiencia profesional',
        jobs=[
            ('Desarrollador PHP / Laravel | Hammer Consult', '06/2023 - Actual | Remoto', [
                'Desarrollo aplicaciones en PHP 8, Laravel y Vue.js para sistemas distribuidos con alto volumen de datos.',
                'Implemento mensajería con Apache Kafka para procesar, de forma asíncrona, eventos de todos los juzgados de Minas Gerais.',
                'Almaceno e indexo grandes volúmenes de datos con MongoDB y Elasticsearch para búsquedas rápidas sobre bases extensas.',
                'Aplico estrategias de caché con Redis para reducir la latencia y la carga en aplicaciones de alta demanda.',
                'Creé servidores MCP (Model Context Protocol) que automatizan procesos e impulsé el uso de GitHub Copilot en el día a día del equipo.']),
            ('Desarrollador Full Stack Sénior | DigiFarmz', '03/2021 - 04/2023 | Remoto', [
                'Fui referente técnico de la arquitectura de una plataforma agtech que monitorea más de 1,5 millones de hectáreas de soja, '
                'incluidas 500 mil hectáreas en Paraguay.',
                'Diseñé y desarrollé microservicios y APIs RESTful en Laravel y Node.js, con frontend en Vue.js y React.',
                'Implementé comunicación asíncrona entre servicios distribuidos con tópicos de Apache Kafka.',
                'Construí pipelines de CI/CD que <b>redujeron los rollbacks en 90% y elevaron la calidad de los releases en 20%</b>.',
                'Conduje el despliegue, la escalabilidad y el monitoreo de las aplicaciones en producción en AWS.']),
            ('Desarrollador Backend | Data Cempro Software', '07/2017 - 01/2021', [
                'Desarrollé y evolucioné módulos críticos de ERP en PHP, Java y JavaScript, con soporte técnico directo a clientes.']),
            ('Programador Backend | F1 Soluções', '10/2015 - 06/2017 | São Leopoldo, RS', [
                'Desarrollé APIs y aplicaciones backend en Node.js y CakePHP y optimicé bases MySQL de alto rendimiento.']),
            ('Programador Full Stack | SPOT Monitoramento e Tecnologia', '03/2014 - 10/2015 | Porto Alegre, RS', [
                'Desarrollé sistemas web en Java, JavaScript y PHP, con integración de APIs externas, en un equipo de ingeniería '
                'de más de 100 personas.'])],
        earlier_h='Experiencia anterior (2007 - 2014)',
        earlier='Desarrollador Web/Java en N2 Agência Web (2013 - 2014) y Desarrollador XHarbour en SYGECOM (2009 - 2013) '
                'y en Data Cempro Software (2007 - 2008), en Porto Alegre, RS: sistemas web en PHP y JavaScript y '
                'sistemas de gestión empresarial en XHarbour y Webspeed.',
        proj_h='Proyectos',
        projects=[
            ('Distributed Systems Playground (en vivo en AWS)',
             'E-commerce serverless con 5 microservicios en Node.js, AWS Lambda y DynamoDB. Patrón Saga en Step Functions con '
             'compensación, idempotencia, EventBridge con DLQ, ingeniería del caos y SLOs (p95 por debajo de 2 s, 99,5% de las sagas '
             'completadas o compensadas). AWS SAM, X-Ray y DevSecOps (Semgrep, Gitleaks, Checkov, OWASP ZAP).',
             [f'{SITE}/laboratory', REPO]),
            ('HüberClaude (open source)',
             'Agente de código con IA para la terminal Linux integrado con OpenRouter: una única clave de API da acceso a miles de '
             'modelos de IA (LLMs) con pago por uso.', [f'{SITE}/huberclaude']),
            ('Observatorio de Combustibles (en vivo)',
             'Pipeline de datos (ETL) que publica el mapa de precios de gasolina, etanol, diésel y GNV por estado de Brasil, '
             'actualizado automáticamente cada 10 días con datos abiertos de la ANP, por cerca de US$ 2,60/mes. Apache Airflow, '
             'dbt y AWS Lambda.', [f'{SITE}/gasolina']),
            ('Maya, tutora de inglés con IA (en vivo)',
             'Aplicación con LLM que conduce conversaciones en inglés y corrige errores con explicaciones en portugués. Backend en '
             'Go con React embebido en un único binario, en un contenedor Docker en AWS EC2.', [f'{SITE}/teacher']),
            ('James Tip (presentado en Shark Tank Brasil)',
             'Uno de los desarrolladores de la IA que identifica patrones de consumo y prevé ventas para optimizar el inventario en '
             'el comercio minorista; el producto se presentó en Shark Tank Brasil y cerró una ronda de inversión.', [])],
        edu_h='Formación académica',
        edu='Tecnólogo en Análisis y Desarrollo de Sistemas | UNIASSELVI | Concluido en 2025',
        courses_h='Cursos y certificaciones',
        courses='Entrenamiento DL - Desarrollo y Liderazgo | INEXH - Instituto Nacional de Excelência Humana | 08/2020',
        lang_h='Idiomas',
        langs='Portugués: nativo | Inglés: básico (A2), con lectura técnica de documentación'),
}


def build(c):
    doc = SimpleDocTemplate(os.path.join(OUT, c['file']), pagesize=A4, leftMargin=17 * mm, rightMargin=17 * mm,
                            topMargin=13 * mm, bottomMargin=13 * mm, title=c['doc'], subject=c['subject'], author='Leandro Huber',
                            keywords=c['keywords'].replace(' | ', ', '))
    f = [Paragraph('Leandro Huber', ST['name']), Paragraph(c['title'], ST['title']), Paragraph(c['keywords'], ST['center']),
         Paragraph(f"{c['place']} | (48) 98811-4351 | <link href='mailto:emaildohuber@gmail.com' color='{LINK}'>emaildohuber@gmail.com</link>", ST['center']),
         Paragraph(' | '.join(link(u) for u in ('linkedin.com/in/leandrohuberdev', 'github.com/Leandrodasilvahuber', SITE)), ST['center'])]
    f += heading(c['summary_h']) + [Paragraph(c['summary'], ST['p'])]
    f += heading(c['skills_h']) + [Paragraph(f'<b>{k}:</b> {v}', ST['skill']) for k, v in c['skills']]
    f += heading(c['exp_h'])
    for role, when, items in c['jobs']:
        f += [KeepTogether([Paragraph(role, ST['job']), Paragraph(when, ST['when']), bullets(items)])]
    f += [KeepTogether([Paragraph(c['earlier_h'], ST['job']), Paragraph(c['earlier'], ST['p'])])]
    items = [f"<b>{name}:</b> {text}" + (' ' + ' | '.join(link(u) for u in urls) if urls else '') for name, text, urls in c['projects']]
    # O título vai junto do primeiro projeto, para não ficar sozinho no fim da página
    spacer, *title = heading(c['proj_h'])
    f += [spacer, KeepTogether(title + [bullets(items[:1])]), bullets(items[1:])]
    f += heading(c['edu_h']) + [Paragraph(c['edu'], ST['p'])]
    f += heading(c['courses_h']) + [Paragraph(c['courses'], ST['p'])]
    f += heading(c['lang_h']) + [Paragraph(c['langs'], ST['p'])]
    doc.build(f)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for lang in CV.values():
        build(lang)
        print('ok', lang['file'])
