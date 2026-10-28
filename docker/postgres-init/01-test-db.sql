-- Throwaway database for the test suite (wiped by every test run). Runs only on a fresh volume.
create database hive_test;
\connect hive_test
create extension if not exists vector;
