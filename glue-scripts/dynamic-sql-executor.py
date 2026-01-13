import sys
from awsglue.utils import getResolvedOptions
from pyspark.context import SparkContext
from awsglue.context import GlueContext
from awsglue.job import Job
import boto3
import json
from datetime import datetime

# Get required job parameters first
args = getResolvedOptions(sys.argv, [
    'JOB_NAME',      # ✅ AWS Glue provides this automatically
    'sql_query',     # ✅ Required - must be passed
    'session_id'     # ✅ Required - always passed by trigger
])

# Try to get optional parameters, use defaults if not provided
try:
    optional_args = getResolvedOptions(sys.argv, ['output_path'])
    args.update(optional_args)
except:
    # output_path parameter not provided, will use default
    pass

sc = SparkContext()
glueContext = GlueContext(sc)
spark = glueContext.spark_session

# Configure Spark for better performance
# Note: catalogImplementation is static in Glue 5.0 and automatically set to use Glue Data Catalog
# Note: spark.serializer and extensions are managed by AWS Glue and cannot be modified in Glue 5.0
spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.coalescePartitions.enabled", "true")
spark.conf.set("spark.sql.hive.convertMetastoreParquet", "false")

# Hudi is automatically supported when --datalake-formats=hudi is set in job parameters

# List available databases for debugging
print("Available databases:")
try:
    for db in spark.catalog.listDatabases():
        print(f"  - {db.name}")
except Exception as e:
    print(f"  Error listing databases: {e}")

job = Job(glueContext)
job.init(args['JOB_NAME'], args)

try:
    # Get the SQL query from job arguments
    sql_query = args['sql_query']
    output_path = args.get('output_path', 's3://dq-utlity-ai-durgamj/output/')
    session_id = args.get('session_id', 'unknown')
    
    print(f"=== Dynamic SQL Executor Started ===")
    print(f"Session ID: {session_id}")
    print(f"SQL Query: {sql_query}")
    print(f"Output Path: {output_path}")
    
        # 🔍 DEBUG: verify Glue catalog visibility
    print("\n=== Available Databases ===")
    spark.sql("SHOW DATABASES").show(truncate=False)
    
    # Execute the dynamic SQL query with Hudi fallback handling
    print("Executing SQL query...")
    try:
        result_df = spark.sql(sql_query)
    except Exception as hudi_error:
        if "HoodieIOException" in str(hudi_error) or "hoodie.properties" in str(hudi_error):
            print(f"Hudi access failed: {hudi_error}")
            print("Attempting to read table through Glue Data Catalog...")
            
            # Try to read the table directly from S3 using Glue catalog metadata
            table_name = "vendor_master_details"  # Extract from query if needed
            database_name = "ap_datamart"
            
            # Get table location from Glue catalog
            glue_client = boto3.client('glue')
            table_info = glue_client.get_table(DatabaseName=database_name, Name=table_name)
            table_location = table_info['Table']['StorageDescriptor']['Location']
            
            print(f"Reading table from location: {table_location}")
            
            # Read as Parquet files directly (bypassing Hudi metadata)
            df_direct = spark.read.parquet(table_location)
            df_direct.createOrReplaceTempView(f"{database_name}_{table_name}")
            
            # Modify query to use the temp view
            modified_query = sql_query.replace(f"{database_name}.{table_name}", f"{database_name}_{table_name}")
            print(f"Modified query: {modified_query}")
            result_df = spark.sql(modified_query)
        else:
            raise hudi_error
    
    # Get row count for summary
    row_count = result_df.count()
    print(f"Query returned {row_count} rows")
    
    # Write results to S3
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_location = f"{output_path.rstrip('/')}/session_{session_id}/{timestamp}/results/"
    
    print(f"Writing results to: {output_location}")
    result_df.coalesce(1).write.mode("overwrite").option("header", "true").csv(output_location)
    
    # Create execution summary
    summary = {
        "session_id": session_id,
        "execution_timestamp": timestamp,
        "query": sql_query,
        "output_location": output_location,
        "row_count": row_count,
        "status": "SUCCESS",
        "columns": result_df.columns
    }
    
    # Write summary as JSON
    summary_location = f"{output_path.rstrip('/')}/session_{session_id}/{timestamp}/summary.json"
    summary_df = spark.createDataFrame([summary])
    summary_df.coalesce(1).write.mode("overwrite").json(summary_location)
    
    print(f"=== Execution Summary ===")
    print(json.dumps(summary, indent=2))
    print(f"Summary written to: {summary_location}")
    print("=== Dynamic SQL Executor Completed Successfully ===")

except Exception as e:
    error_msg = f"Error executing SQL query: {str(e)}"
    print(f"=== ERROR ===")
    print(error_msg)
    
    # Write error summary
    error_summary = {
        "session_id": session_id,
        "execution_timestamp": datetime.now().strftime("%Y%m%d_%H%M%S"),
        "query": sql_query,
        "status": "FAILED",
        "error": str(e)
    }
    
    try:
        error_location = f"{output_path.rstrip('/')}/session_{session_id}/error_{error_summary['execution_timestamp']}.json"
        error_df = spark.createDataFrame([error_summary])
        error_df.coalesce(1).write.mode("overwrite").json(error_location)
        print(f"Error summary written to: {error_location}")
    except:
        print("Failed to write error summary")
    
    raise e

finally:
    job.commit()
